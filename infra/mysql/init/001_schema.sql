CREATE DATABASE IF NOT EXISTS prguard CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE prguard;

CREATE TABLE IF NOT EXISTS projects (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  repository_root TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_projects_name_root (name, repository_root(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS review_jobs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  status VARCHAR(16) NOT NULL,
  multi_agent BOOLEAN NOT NULL DEFAULT FALSE,
  cwd TEXT NOT NULL,
  input_json JSON NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 3,
  fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
  lease_owner VARCHAR(128) NULL,
  lease_expires_at DATETIME(3) NULL,
  github_feedback_published_at DATETIME(3) NULL,
  publish_feedback BOOLEAN NOT NULL DEFAULT FALSE,
  created_by VARCHAR(191) NULL,
  run_id VARCHAR(64) NULL,
  result_json JSON NULL,
  error_message TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_review_jobs_status_created (status, created_at),
  KEY idx_review_jobs_lease_expiry (status, lease_expires_at),
  KEY idx_review_jobs_run_id (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS review_job_outbox (
  id CHAR(32) NOT NULL PRIMARY KEY,
  job_id VARCHAR(64) NOT NULL,
  event_kind VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  available_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  status VARCHAR(16) NOT NULL,
  publish_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  published_at DATETIME(3) NULL,
  last_error TEXT NULL,
  source_dead_letter_id VARCHAR(128) NULL,
  UNIQUE KEY uk_review_job_outbox_idempotency (idempotency_key),
  KEY idx_review_job_outbox_due (status, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reviews (
  id CHAR(36) NOT NULL PRIMARY KEY,
  project_id BIGINT UNSIGNED NULL,
  job_id VARCHAR(64) NULL,
  review_id CHAR(36) NOT NULL,
  branch_name VARCHAR(255) NULL,
  finding_count INT UNSIGNED NOT NULL DEFAULT 0,
  result_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_reviews_review_id (review_id),
  KEY idx_reviews_project_created (project_id, created_at),
  CONSTRAINT fk_reviews_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS findings (
  id VARCHAR(128) NOT NULL PRIMARY KEY,
  review_id CHAR(36) NOT NULL,
  category VARCHAR(32) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  confidence DECIMAL(5,4) NOT NULL,
  status VARCHAR(16) NOT NULL,
  file_path TEXT NOT NULL,
  line_start INT UNSIGNED NOT NULL,
  line_end INT UNSIGNED NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggested_fix TEXT NOT NULL,
  evidence_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_findings_review (review_id),
  KEY idx_findings_severity (severity),
  CONSTRAINT fk_findings_review FOREIGN KEY (review_id) REFERENCES reviews(review_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS patches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  review_id CHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL,
  summary TEXT NOT NULL,
  unified_diff MEDIUMTEXT NOT NULL,
  finding_ids_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_patches_review (review_id),
  CONSTRAINT fk_patches_review FOREIGN KEY (review_id) REFERENCES reviews(review_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trace_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  sequence_no INT UNSIGNED NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_trace_sequence (run_id, sequence_no),
  KEY idx_trace_run_created (run_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
