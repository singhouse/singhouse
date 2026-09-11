-- Deployed core+premium schema as of a 2026-07-16 snapshot.
-- DDL ONLY — captured via: sqlite3 <snapshot> .schema
-- NO user data: the regression net captured before the boot-time DDL was removed.
-- owner_id / custom_lyrics / active_lyrics_id / singers.one_shot were all
-- added to the deployed DB via ALTER, so they are SQL-nullable here — the
-- shape init_db's idempotent ALTERs must leave untouched (except-pass).
--
CREATE TABLE songs (
	id INTEGER NOT NULL, 
	artist VARCHAR(255) NOT NULL, 
	title VARCHAR(255) NOT NULL, 
	filename VARCHAR(512) NOT NULL, 
	duration FLOAT, 
	status VARCHAR(20) NOT NULL, 
	created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, 
	updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, 
	stems_path VARCHAR(512), 
	job_id VARCHAR(64), 
	lyrics_synced BOOLEAN NOT NULL, 
	word_sync_json TEXT, 
	error_message TEXT, custom_lyrics TEXT, active_lyrics_id INTEGER REFERENCES lyrics_sets(id) ON DELETE SET NULL, owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_songs_id ON songs (id);
CREATE INDEX ix_songs_title ON songs (title);
CREATE INDEX ix_songs_job_id ON songs (job_id);
CREATE INDEX ix_songs_artist ON songs (artist);
CREATE INDEX ix_songs_status ON songs (status);
CREATE TABLE jobs (
	id VARCHAR(64) NOT NULL, 
	song_id INTEGER, 
	status VARCHAR(20) NOT NULL, 
	progress INTEGER, 
	message TEXT, 
	created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, 
	updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, 
	stems TEXT, 
	error_message TEXT, owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(song_id) REFERENCES songs (id) ON DELETE CASCADE
);
CREATE INDEX ix_jobs_song_id ON jobs (song_id);
CREATE INDEX ix_jobs_status ON jobs (status);
CREATE TABLE lyrics_sets (
	id INTEGER NOT NULL, 
	song_id INTEGER NOT NULL, 
	source VARCHAR(32) NOT NULL, 
	label VARCHAR(255), 
	is_verified BOOLEAN NOT NULL, 
	plain_lyrics TEXT, 
	synced_lyrics TEXT, 
	word_sync_json TEXT, 
	metadata_json TEXT, 
	created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, 
	updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_lyrics_song_id UNIQUE (song_id, id), 
	FOREIGN KEY(song_id) REFERENCES songs (id) ON DELETE CASCADE
);
CREATE INDEX ix_lyrics_sets_id ON lyrics_sets (id);
CREATE INDEX ix_lyrics_sets_song_id ON lyrics_sets (song_id);
CREATE INDEX ix_lyrics_sets_is_verified ON lyrics_sets (is_verified);
CREATE TABLE shows (
	id INTEGER NOT NULL, 
	name VARCHAR(120), 
	started_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, 
	ended_at DATETIME, owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_shows_id ON shows (id);
CREATE TABLE singers (
	id INTEGER NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	client_id VARCHAR(64), 
	rotation_position INTEGER NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	notes VARCHAR(200), 
	created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, 
	updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE, one_shot BOOLEAN NOT NULL DEFAULT 0, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_singers_rotation_position ON singers (rotation_position);
CREATE INDEX ix_singers_status ON singers (status);
CREATE INDEX ix_singers_id ON singers (id);
CREATE INDEX ix_singers_client_id ON singers (client_id);
CREATE TABLE singer_songs (
	id INTEGER NOT NULL, 
	singer_id INTEGER NOT NULL, 
	song VARCHAR(200) NOT NULL, 
	song_id INTEGER, 
	position INTEGER NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	show_id INTEGER, 
	sung_at DATETIME, 
	created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(singer_id) REFERENCES singers (id) ON DELETE CASCADE, 
	FOREIGN KEY(song_id) REFERENCES songs (id) ON DELETE SET NULL, 
	FOREIGN KEY(show_id) REFERENCES shows (id) ON DELETE SET NULL
);
CREATE INDEX ix_singer_songs_id ON singer_songs (id);
CREATE INDEX ix_singer_songs_position ON singer_songs (position);
CREATE INDEX ix_singer_songs_status ON singer_songs (status);
CREATE INDEX ix_singer_songs_singer_id ON singer_songs (singer_id);
CREATE INDEX ix_singer_songs_song_id ON singer_songs (song_id);
CREATE INDEX ix_singer_songs_show_id ON singer_songs (show_id);
CREATE TABLE users (
	id INTEGER NOT NULL, 
	email VARCHAR(254) NOT NULL, 
	name VARCHAR(120), 
	password_hash VARCHAR(255) NOT NULL, 
	is_admin BOOLEAN NOT NULL, 
	created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, 
	last_login_at DATETIME, 
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX ix_users_email ON users (email);
CREATE INDEX ix_users_id ON users (id);
CREATE TABLE invites (
	id INTEGER NOT NULL, 
	token VARCHAR(64) NOT NULL, 
	email VARCHAR(254), 
	created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, 
	expires_at DATETIME, 
	used_at DATETIME, 
	used_by_user_id INTEGER, 
	PRIMARY KEY (id), 
	FOREIGN KEY(used_by_user_id) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX ix_invites_id ON invites (id);
CREATE UNIQUE INDEX ix_invites_token ON invites (token);
