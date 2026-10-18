-- CreateTable
CREATE TABLE "ai_model_profiles" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "model" VARCHAR(128) NOT NULL,
    "base_url" VARCHAR(512),
    "api_key_enc" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "last_test_at" TIMESTAMP(3),
    "last_test_ok" BOOLEAN,
    "last_test_code" VARCHAR(64),
    "last_test_latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_model_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_profiles_name_key" ON "ai_model_profiles"("name");
