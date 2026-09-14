# SPDX-License-Identifier: AGPL-3.0-only
import asyncio
from pathlib import Path
import unittest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import DesktopMutationBarrier


async def receive():
    return {"type": "http.request", "body": b"", "more_body": False}


def sender(messages):
    async def send(message):
        messages.append(message)
    return send


class MutationBarrierTests(unittest.IsolatedAsyncioTestCase):
    async def test_quiesce_drains_active_mutation_and_rejects_new_one(self):
        entered, finish = asyncio.Event(), asyncio.Event()

        async def app(scope, receive, send):
            entered.set()
            await finish.wait()
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        barrier = DesktopMutationBarrier(app)
        messages = []
        active = asyncio.create_task(barrier(
            {"type": "http", "method": "POST", "path": "/songs"}, receive, sender(messages)))
        await entered.wait()
        draining = asyncio.create_task(barrier.quiesce())
        await asyncio.sleep(0)
        self.assertFalse(draining.done())

        rejected = []
        await barrier({"type": "http", "method": "DELETE", "path": "/songs/1"},
                      receive, sender(rejected))
        self.assertEqual(rejected[0]["status"], 503)
        finish.set()
        await active
        await draining
        self.assertEqual(await barrier.state(), {
            "quiesced": True, "activeMutations": 0, "activeClaims": 0,
            "jobs": {"queued": 0, "running": 0, "nonterminal": 0},
        })

        await barrier.release()
        self.assertEqual(await barrier.state(), {
            "quiesced": False, "activeMutations": 0, "activeClaims": 0,
            "jobs": {"queued": 0, "running": 0, "nonterminal": 0},
        })

    async def test_reads_continue_while_quiesced(self):
        called = False

        async def app(scope, receive, send):
            nonlocal called
            called = True
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        barrier = DesktopMutationBarrier(app)
        await barrier.quiesce()
        messages = []
        await barrier({"type": "http", "method": "GET", "path": "/songs"}, receive, sender(messages))
        self.assertTrue(called)
        self.assertEqual(messages[0]["status"], 200)

    async def test_enqueue_response_can_finish_while_worker_remains_running(self):
        jobs = {"queued": 0, "running": 0, "nonterminal": 0}
        worker_running = asyncio.Event()
        finish_worker = asyncio.Event()
        worker_task = None

        async def counts():
            return dict(jobs)

        async def run_job():
            jobs.update(queued=0, running=1, nonterminal=1)
            worker_running.set()
            await finish_worker.wait()
            jobs.update(queued=0, running=0, nonterminal=0)

        async def app(scope, receive, send):
            nonlocal worker_task
            jobs.update(queued=1, nonterminal=1)
            worker_task = asyncio.create_task(run_job())
            await send({"type": "http.response.start", "status": 202, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        barrier = DesktopMutationBarrier(app, counts)
        messages = []
        await barrier({"type": "http", "method": "POST", "path": "/jobs"},
                      receive, sender(messages))
        await worker_running.wait()

        await barrier.quiesce()
        state = await barrier.state()
        self.assertEqual(messages[0]["status"], 202)
        self.assertEqual(state["activeMutations"], 0)
        self.assertEqual(state["jobs"], {"queued": 0, "running": 1, "nonterminal": 1})

        finish_worker.set()
        await worker_task

    async def test_quiesce_and_claim_share_one_admission_gate(self):
        claim_entered = asyncio.Event()
        finish_claim = asyncio.Event()

        class Worker:
            async def _claim_up_to_concurrency(self):
                claim_entered.set()
                await finish_claim.wait()
                return 1

        barrier = DesktopMutationBarrier(lambda *_: None)
        worker = Worker()
        barrier.bind_job_worker(worker)

        claiming = asyncio.create_task(worker._claim_up_to_concurrency())
        await claim_entered.wait()
        quiescing = asyncio.create_task(barrier.quiesce())
        await asyncio.sleep(0)
        self.assertFalse(quiescing.done())

        finish_claim.set()
        self.assertEqual(await claiming, 1)
        await quiescing
        self.assertEqual(await worker._claim_up_to_concurrency(), 0)
        self.assertEqual((await barrier.state())["activeClaims"], 0)


if __name__ == "__main__":
    unittest.main()
