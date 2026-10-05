-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(191) NOT NULL,
    "email" VARCHAR(191) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" VARCHAR(32) NOT NULL DEFAULT 'user',
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(191) NOT NULL,
    "key_prefix" VARCHAR(32) NOT NULL,
    "key_hash" VARCHAR(255) NOT NULL,
    "scopes" JSONB NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_routing_policies" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" VARCHAR(32) NOT NULL DEFAULT 'most_available',
    "priority_account_ids" JSONB NOT NULL,
    "round_robin_cursor" INTEGER NOT NULL DEFAULT 0,
    "file_type_rules" JSONB,
    "min_file_size_bytes" BIGINT,
    "max_file_size_bytes" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_routing_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" VARCHAR(255) NOT NULL,
    "prev_refresh_token_hash" VARCHAR(255),
    "user_agent" TEXT,
    "ip_address" VARCHAR(64),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_handoffs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_configs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "provider" VARCHAR(32) NOT NULL,
    "client_id_encrypted" TEXT NOT NULL,
    "client_secret_encrypted" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "provider_config_id" UUID NOT NULL,
    "flow" VARCHAR(32) NOT NULL DEFAULT 'connect',
    "state_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connected_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_config_id" UUID,
    "provider" VARCHAR(32) NOT NULL,
    "provider_account_id" VARCHAR(191) NOT NULL,
    "email" VARCHAR(191) NOT NULL,
    "display_name" VARCHAR(191),
    "avatar_url" TEXT,
    "access_token_encrypted" TEXT,
    "refresh_token_encrypted" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "scopes" JSONB NOT NULL,
    "metadata" JSONB,
    "status" VARCHAR(32) NOT NULL DEFAULT 'connected',
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connected_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "s3_storage_configs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "connected_account_id" UUID NOT NULL,
    "name" VARCHAR(191) NOT NULL,
    "bucket" VARCHAR(191) NOT NULL,
    "region" VARCHAR(191) NOT NULL,
    "endpoint" TEXT,
    "access_key_id_encrypted" TEXT NOT NULL,
    "secret_access_key_encrypted" TEXT NOT NULL,
    "force_path_style" BOOLEAN NOT NULL DEFAULT false,
    "prefix" VARCHAR(191) NOT NULL DEFAULT '9drive',
    "quota_bytes" BIGINT,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "s3_storage_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_accounts" (
    "id" UUID NOT NULL,
    "connected_account_id" UUID NOT NULL,
    "total_bytes" BIGINT,
    "used_bytes" BIGINT NOT NULL DEFAULT 0,
    "available_bytes" BIGINT,
    "trash_bytes" BIGINT,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "connected_account_id" UUID NOT NULL,
    "folder_id" UUID,
    "provider" VARCHAR(32) NOT NULL,
    "provider_file_id" VARCHAR(191) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(191) NOT NULL,
    "sniffed_mime_type" VARCHAR(191),
    "size_bytes" BIGINT NOT NULL,
    "checksum" VARCHAR(191),
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "remote_parent_id" VARCHAR(255),
    "replicated_from_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_shares" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_preview_tokens" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_preview_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "parent_id" UUID,
    "connected_account_id" UUID,
    "provider" VARCHAR(32) NOT NULL DEFAULT '',
    "provider_folder_id" VARCHAR(191),
    "name" VARCHAR(255) NOT NULL,
    "color" VARCHAR(64) NOT NULL DEFAULT 'text-blue-500',
    "icon_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "target_connected_account_id" UUID,
    "folder_id" UUID,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(191) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "google_session_uri" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" VARCHAR(191) NOT NULL,
    "entity_type" VARCHAR(191) NOT NULL,
    "entity_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_invites" (
    "id" UUID NOT NULL,
    "inviter_id" UUID NOT NULL,
    "invitee_email" VARCHAR(191) NOT NULL,
    "target_type" VARCHAR(32) NOT NULL DEFAULT 'file',
    "target_id" TEXT NOT NULL DEFAULT '',
    "role" VARCHAR(32) NOT NULL DEFAULT 'viewer',
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "revoked_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_capabilities" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "capability" VARCHAR(32) NOT NULL,
    "supported" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_health" (
    "id" UUID NOT NULL,
    "connected_account_id" UUID,
    "provider" VARCHAR(32) NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'unknown',
    "latencyMs" INTEGER,
    "message" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "type" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "provider" VARCHAR(32),
    "related_id" UUID,
    "bull_job_id" VARCHAR(64),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replication_jobs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_account_id" UUID NOT NULL,
    "target_account_id" UUID NOT NULL,
    "scope" JSONB NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "filesTotal" INTEGER NOT NULL DEFAULT 0,
    "filesCopied" INTEGER NOT NULL DEFAULT 0,
    "filesFailed" INTEGER NOT NULL DEFAULT 0,
    "bytesCopied" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "replication_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migration_jobs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_account_id" UUID NOT NULL,
    "target_account_id" UUID NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "mode" VARCHAR(16) NOT NULL DEFAULT 'copy',
    "filesTotal" INTEGER NOT NULL DEFAULT 0,
    "filesDone" INTEGER NOT NULL DEFAULT 0,
    "filesFailed" INTEGER NOT NULL DEFAULT 0,
    "bytesMoved" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "migration_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_operations" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "account_id" UUID,
    "provider" VARCHAR(32),
    "operation" VARCHAR(64) NOT NULL,
    "file_id" UUID,
    "status" VARCHAR(16) NOT NULL,
    "latencyMs" INTEGER,
    "bytes" BIGINT,
    "error_code" VARCHAR(64),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "events" JSONB NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "api_keys_user_id_status_created_at_idx" ON "api_keys"("user_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "upload_routing_policies_user_id_key" ON "upload_routing_policies"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_prev_refresh_token_hash_key" ON "user_sessions"("prev_refresh_token_hash");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "user_sessions_refresh_token_hash_idx" ON "user_sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "auth_handoffs_token_hash_key" ON "auth_handoffs"("token_hash");

-- CreateIndex
CREATE INDEX "auth_handoffs_user_id_idx" ON "auth_handoffs"("user_id");

-- CreateIndex
CREATE INDEX "provider_configs_user_id_idx" ON "provider_configs"("user_id");

-- CreateIndex
CREATE INDEX "provider_configs_provider_idx" ON "provider_configs"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_hash_key" ON "oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "oauth_states_user_id_idx" ON "oauth_states"("user_id");

-- CreateIndex
CREATE INDEX "connected_accounts_user_id_idx" ON "connected_accounts"("user_id");

-- CreateIndex
CREATE INDEX "connected_accounts_user_id_status_created_at_idx" ON "connected_accounts"("user_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "connected_accounts_user_id_provider_provider_account_id_key" ON "connected_accounts"("user_id", "provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "s3_storage_configs_connected_account_id_key" ON "s3_storage_configs"("connected_account_id");

-- CreateIndex
CREATE INDEX "s3_storage_configs_user_id_idx" ON "s3_storage_configs"("user_id");

-- CreateIndex
CREATE INDEX "s3_storage_configs_user_id_status_idx" ON "s3_storage_configs"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "storage_accounts_connected_account_id_key" ON "storage_accounts"("connected_account_id");

-- CreateIndex
CREATE INDEX "files_user_id_idx" ON "files"("user_id");

-- CreateIndex
CREATE INDEX "files_user_id_status_created_at_idx" ON "files"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "files_user_id_status_folder_id_created_at_idx" ON "files"("user_id", "status", "folder_id", "created_at");

-- CreateIndex
CREATE INDEX "files_connected_account_id_idx" ON "files"("connected_account_id");

-- CreateIndex
CREATE INDEX "files_folder_id_idx" ON "files"("folder_id");

-- CreateIndex
CREATE INDEX "files_provider_file_id_idx" ON "files"("provider_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_shares_token_hash_key" ON "file_shares"("token_hash");

-- CreateIndex
CREATE INDEX "file_shares_file_id_idx" ON "file_shares"("file_id");

-- CreateIndex
CREATE INDEX "file_shares_user_id_idx" ON "file_shares"("user_id");

-- CreateIndex
CREATE INDEX "file_shares_user_id_enabled_created_at_idx" ON "file_shares"("user_id", "enabled", "created_at");

-- CreateIndex
CREATE INDEX "file_shares_file_id_user_id_enabled_created_at_idx" ON "file_shares"("file_id", "user_id", "enabled", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "file_preview_tokens_token_hash_key" ON "file_preview_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "file_preview_tokens_file_id_idx" ON "file_preview_tokens"("file_id");

-- CreateIndex
CREATE INDEX "file_preview_tokens_user_id_idx" ON "file_preview_tokens"("user_id");

-- CreateIndex
CREATE INDEX "folders_user_id_idx" ON "folders"("user_id");

-- CreateIndex
CREATE INDEX "folders_user_id_deleted_at_updated_at_idx" ON "folders"("user_id", "deleted_at", "updated_at");

-- CreateIndex
CREATE INDEX "folders_user_id_deleted_at_parent_id_updated_at_idx" ON "folders"("user_id", "deleted_at", "parent_id", "updated_at");

-- CreateIndex
CREATE INDEX "folders_parent_id_idx" ON "folders"("parent_id");

-- CreateIndex
CREATE INDEX "folders_connected_account_id_idx" ON "folders"("connected_account_id");

-- CreateIndex
CREATE INDEX "upload_sessions_user_id_idx" ON "upload_sessions"("user_id");

-- CreateIndex
CREATE INDEX "upload_sessions_folder_id_idx" ON "upload_sessions"("folder_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "workspace_invites_invitee_email_idx" ON "workspace_invites"("invitee_email");

-- CreateIndex
CREATE INDEX "workspace_invites_target_type_target_id_idx" ON "workspace_invites"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invites_target_unique" ON "workspace_invites"("inviter_id", "invitee_email", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "provider_capabilities_provider_idx" ON "provider_capabilities"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "provider_capabilities_provider_capability_key" ON "provider_capabilities"("provider", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "provider_health_connected_account_id_key" ON "provider_health"("connected_account_id");

-- CreateIndex
CREATE INDEX "provider_health_provider_state_idx" ON "provider_health"("provider", "state");

-- CreateIndex
CREATE INDEX "provider_health_checkedAt_idx" ON "provider_health"("checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_bull_job_id_key" ON "jobs"("bull_job_id");

-- CreateIndex
CREATE INDEX "jobs_user_id_type_status_createdAt_idx" ON "jobs"("user_id", "type", "status", "createdAt");

-- CreateIndex
CREATE INDEX "jobs_status_createdAt_idx" ON "jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "jobs_type_createdAt_idx" ON "jobs"("type", "createdAt");

-- CreateIndex
CREATE INDEX "replication_jobs_user_id_status_createdAt_idx" ON "replication_jobs"("user_id", "status", "createdAt");

-- CreateIndex
CREATE INDEX "migration_jobs_user_id_status_createdAt_idx" ON "migration_jobs"("user_id", "status", "createdAt");

-- CreateIndex
CREATE INDEX "storage_operations_user_id_createdAt_idx" ON "storage_operations"("user_id", "createdAt");

-- CreateIndex
CREATE INDEX "storage_operations_account_id_createdAt_idx" ON "storage_operations"("account_id", "createdAt");

-- CreateIndex
CREATE INDEX "storage_operations_operation_status_createdAt_idx" ON "storage_operations"("operation", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_subscriptions_user_id_url_key" ON "webhook_subscriptions"("user_id", "url");

-- CreateIndex
CREATE INDEX "webhook_deliveries_subscription_id_status_nextAttemptAt_idx" ON "webhook_deliveries"("subscription_id", "status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_routing_policies" ADD CONSTRAINT "upload_routing_policies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_handoffs" ADD CONSTRAINT "auth_handoffs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_provider_config_id_fkey" FOREIGN KEY ("provider_config_id") REFERENCES "provider_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_provider_config_id_fkey" FOREIGN KEY ("provider_config_id") REFERENCES "provider_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "s3_storage_configs" ADD CONSTRAINT "s3_storage_configs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "s3_storage_configs" ADD CONSTRAINT "s3_storage_configs_connected_account_id_fkey" FOREIGN KEY ("connected_account_id") REFERENCES "connected_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_accounts" ADD CONSTRAINT "storage_accounts_connected_account_id_fkey" FOREIGN KEY ("connected_account_id") REFERENCES "connected_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_connected_account_id_fkey" FOREIGN KEY ("connected_account_id") REFERENCES "connected_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_preview_tokens" ADD CONSTRAINT "file_preview_tokens_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_preview_tokens" ADD CONSTRAINT "file_preview_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_connected_account_id_fkey" FOREIGN KEY ("connected_account_id") REFERENCES "connected_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_target_connected_account_id_fkey" FOREIGN KEY ("target_connected_account_id") REFERENCES "connected_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
