# SPDX-License-Identifier: AGPL-3.0-only
"""SQLAlchemy models for the karaoke database."""

import enum
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    Column,
    DateTime,
    Float,
    ForeignKey,
    Boolean,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


class SongStatus(str, enum.Enum):
    UPLOADING = "uploading"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class JobStatus(str, enum.Enum):
    """Job LIFECYCLE, and nothing else.

    Before the durable queue this column carried the pipeline phase as well,
    so "what the worker is doing" and "is this row claimable" were the same
    field — and a claim could not be expressed as a guarded state transition.
    The phase strings moved to ``Job.phase``; what is left is the four states
    the queue itself transitions between.
    """

    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class JobPhase(str, enum.Enum):
    """UI-facing pipeline phase — what the operator sees while a job runs."""

    QUEUED = "queued"
    SEPARATING = "separating"
    FETCHING_LYRICS = "fetching_lyrics"
    TRANSCRIBING = "transcribing"
    ALIGNING = "aligning"
    IMPORTING = "importing"
    DONE = "done"
    FAILED = "failed"


class JobKind(str, enum.Enum):
    """Which handler runs a job. NULL on legacy pre-queue rows."""

    INGEST = "ingest"
    RETRANSCRIBE = "retranscribe"
    REALIGN = "realign"
    PAGE = "page"
    RESPLIT = "resplit"
    CATALOG_IMPORT = "catalog_import"
    VIDEO_IMPORT = "video_import"
    PLEX_IMPORT = "plex_import"


class LyricsSource(str, enum.Enum):
    REFERENCE = "reference"        # externally verified ground truth
    TRANSCRIPTION = "transcription"  # produced by lyricsync pipeline
    LRCLIB = "lrclib"              # raw lrclib fetch (no per-word timing)
    MANUAL = "manual"              # user-edited via LyricsEditor


class Song(Base):
    """A processed song with separated stems."""

    __tablename__ = "songs"

    id: int = Column(Integer, primary_key=True, index=True)
    # Tenant scoping. In multi-user (premium) assembly every Song belongs to the
    # host who imported it; per-host libraries are listed via WHERE owner_id.
    # The FK + NOT NULL are stripped from the MODEL so a fresh single-host core
    # DB — where no `users` table is registered on Base.metadata — can create
    # this table under PRAGMA foreign_keys=ON without a NoReferencedTableError.
    #
    # DB-level integrity by deployment kind:
    #   - EXISTING DBs (incl. the live premium DB): keep their baked-in FK +
    #     NOT NULL — create_all no-ops on already-created tables.
    #   - FRESH premium installs: create this table from the stripped model, so
    #     they get LOGICAL-only integrity (nullable, no CASCADE) until a later
    #     premium migration re-adds DB-level enforcement. Accepted by design
    #     (scoping stays query-level, ORM inserts always supply owner_id,
    #     no user-deletion flow exists).
    #   - Core (single-host): scopes to the constant SINGLE_HOST_ID; owner_id
    #     is bookkeeping, never an FK.
    owner_id: int = Column(
        Integer,
        nullable=True,
        index=True,
    )
    artist: str = Column(String(255), nullable=False, index=True)
    title: str = Column(String(255), nullable=False, index=True)
    filename: str = Column(String(512), nullable=False)          # original uploaded filename
    duration: Optional[float] = Column(Float, nullable=True)     # seconds
    status: str = Column(
        String(20),
        nullable=False,
        default=SongStatus.PROCESSING.value,
        index=True,
    )
    created_at: datetime = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: datetime = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    stems_path: Optional[str] = Column(String(512), nullable=True)  # local dir with stem files
    # Basename — never a path — of a karaoke video retained inside this song's
    # stems directory (e.g. "video.mp4"). Set only by the video-import job,
    # which keeps the operator's own file as the song's display content and
    # extracts its audio into the usual instrumental stem so playback runs
    # through the existing mixer. NULL on every other song: no video, and the
    # player falls back to its own rendering.
    video_filename: Optional[str] = Column(String(512), nullable=True)
    job_id: Optional[str] = Column(String(64), nullable=True, index=True)  # Modal job reference
    active_lyrics_id: Optional[int] = Column(
        Integer,
        ForeignKey("lyrics_sets.id", ondelete="SET NULL", use_alter=True, name="fk_songs_active_lyrics"),
        nullable=True,
    )
    error_message: Optional[str] = Column(Text, nullable=True)

    # Legacy columns kept for one release for safe rollback. Read-only after
    # migration; new writes go to lyrics_sets.
    word_sync_json: Optional[str] = Column(Text, nullable=True)
    custom_lyrics: Optional[str] = Column(Text, nullable=True)
    lyrics_synced: bool = Column(Boolean, default=False, nullable=False)

    jobs = relationship("Job", back_populates="song", cascade="all, delete-orphan", passive_deletes=True)
    lyrics_sets = relationship(
        "LyricsSet",
        back_populates="song",
        cascade="all, delete-orphan",
        passive_deletes=True,
        foreign_keys="LyricsSet.song_id",
    )
    active_lyrics = relationship(
        "LyricsSet",
        foreign_keys=[active_lyrics_id],
        post_update=True,
    )

    def __repr__(self) -> str:
        return f"<Song id={self.id} artist={self.artist!r} title={self.title!r} status={self.status!r}>"


class Job(Base):
    """A durable unit of background work.

    Every long-running task rides this one table: ingest, re-transcribe,
    re-align, catalog import. ``status`` is the lifecycle the worker claims
    against; ``phase`` is what the UI shows.
    """

    __tablename__ = "jobs"
    __table_args__ = (
        # The worker's two hot queries: claim (status='queued') and
        # expiry sweep (status='running' AND lease_expires_at < now).
        Index("ix_jobs_status_lease", "status", "lease_expires_at"),
    )

    id: str = Column(String(64), primary_key=True)  # UUID
    # See Song.owner_id: FK + NOT NULL stripped from the model for fresh
    # single-host DBs; existing DBs and premium enforcement are unaffected.
    owner_id: int = Column(
        Integer,
        nullable=True,
        index=True,
    )
    song_id: Optional[int] = Column(Integer, ForeignKey("songs.id", ondelete="CASCADE"), nullable=True, index=True)
    status: str = Column(
        String(32),
        nullable=False,
        default=JobStatus.QUEUED.value,
        index=True,
    )
    progress: int = Column(Integer, default=0)          # 0-100
    message: Optional[str] = Column(Text, nullable=True)
    # This is the QUEUE ORDER, so its resolution is load-bearing. SQLite's
    # CURRENT_TIMESTAMP has one-second granularity, which makes every job
    # enqueued in the same second a tie broken by `id` — a uuid4, i.e. at
    # random. The Python-side default gives microseconds so FIFO is actually
    # FIFO; the server_default stays for inserts that do not come through the
    # ORM (migrations, sqlite3 by hand) and never reaches an ORM insert.
    created_at: datetime = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: datetime = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    stems: Optional[str] = Column(Text, nullable=True)  # JSON: {"instrumental": url, ...}
    error_message: Optional[str] = Column(Text, nullable=True)

    # --- durable queue (c0005) ---------------------------------------------
    # NULL kind marks a LEGACY pre-queue row: no handler can run it, so boot
    # sweeps it rather than leaving it claimable forever.
    kind: Optional[str] = Column(String(32), nullable=True)
    payload: Optional[str] = Column(Text, nullable=True)     # JSON handler args
    attempts: int = Column(Integer, nullable=False, server_default="0", default=0)
    claimed_by: Optional[str] = Column(String(64), nullable=True)
    lease_expires_at: Optional[datetime] = Column(DateTime(timezone=True), nullable=True)
    phase: Optional[str] = Column(String(32), nullable=True)
    started_at: Optional[datetime] = Column(DateTime(timezone=True), nullable=True)
    finished_at: Optional[datetime] = Column(DateTime(timezone=True), nullable=True)

    song = relationship("Song", back_populates="jobs")

    def __repr__(self) -> str:
        return (
            f"<Job id={self.id!r} kind={self.kind!r} status={self.status!r} "
            f"phase={self.phase!r} progress={self.progress}>"
        )


class LyricsSet(Base):
    """A single set of lyrics for a song.

    A song can have many sets (e.g. an externally-verified reference, several
    transcription runs, an lrclib fetch, manual edits). At most one is active
    (drives playback) and at most one is verified (used as eval ground truth).
    """

    __tablename__ = "lyrics_sets"
    __table_args__ = (
        UniqueConstraint("song_id", "id", name="uq_lyrics_song_id"),
    )

    id: int = Column(Integer, primary_key=True, index=True)
    # See Song.owner_id: FK + NOT NULL stripped from the model for fresh
    # single-host DBs; existing DBs and premium enforcement are unaffected.
    owner_id: int = Column(
        Integer,
        nullable=True,
        index=True,
    )
    song_id: int = Column(
        Integer,
        ForeignKey("songs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source: str = Column(
        String(32),
        nullable=False,
        default=LyricsSource.TRANSCRIPTION.value,
    )
    label: Optional[str] = Column(String(255), nullable=True)
    is_verified: bool = Column(Boolean, default=False, nullable=False, index=True)

    plain_lyrics: Optional[str] = Column(Text, nullable=True)
    synced_lyrics: Optional[str] = Column(Text, nullable=True)   # LRC format
    word_sync_json: Optional[str] = Column(Text, nullable=True)  # per-word timing payload

    # Free-form metadata: model name, transcriber config, eval scores, etc.
    metadata_json: Optional[str] = Column(Text, nullable=True)

    created_at: datetime = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: datetime = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    song = relationship("Song", back_populates="lyrics_sets", foreign_keys=[song_id])

    def __repr__(self) -> str:
        return (
            f"<LyricsSet id={self.id} song_id={self.song_id} "
            f"source={self.source!r} verified={self.is_verified}>"
        )
