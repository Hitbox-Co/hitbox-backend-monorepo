-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('new', 'reviewing', 'qualified', 'contacted', 'meeting_scheduled', 'in_discussion', 'on_hold', 'closed_won', 'closed_lost', 'spam');

-- CreateEnum
CREATE TYPE "LeadPriority" AS ENUM ('unreviewed', 'low', 'medium', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('pending', 'confirmed', 'unsubscribed', 'suppressed');

-- CreateTable
CREATE TABLE "waitlist_subscribers" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "email_normalized" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "country" VARCHAR(100),
    "state_region" VARCHAR(100),
    "city" VARCHAR(100),
    "age_range" VARCHAR(20),
    "interests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "music_genres" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "referral_source" VARCHAR(100),
    "utm_source" VARCHAR(255),
    "utm_medium" VARCHAR(255),
    "utm_campaign" VARCHAR(255),
    "utm_content" VARCHAR(255),
    "utm_term" VARCHAR(255),
    "status" "WaitlistStatus" NOT NULL DEFAULT 'pending',
    "confirmation_token_hash" TEXT,
    "confirmation_expires_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "unsubscribed_at" TIMESTAMP(3),
    "consent_version" VARCHAR(20) NOT NULL,
    "consent_timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_page" VARCHAR(255),
    "ip_hash" VARCHAR(64),
    "user_agent_summary" VARCHAR(255),
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waitlist_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_submissions" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "company" VARCHAR(255),
    "phone" VARCHAR(50),
    "topic" VARCHAR(255) NOT NULL,
    "message" TEXT NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "assigned_user_id" TEXT,
    "internal_priority" "LeadPriority" NOT NULL DEFAULT 'unreviewed',
    "follow_up_at" TIMESTAMP(3),
    "source_page" VARCHAR(255),
    "ip_hash" VARCHAR(64),
    "consent_version" VARCHAR(20) NOT NULL,
    "consent_timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artist_leads" (
    "id" TEXT NOT NULL,
    "artist_name" VARCHAR(255) NOT NULL,
    "primary_category" VARCHAR(100),
    "country" VARCHAR(100) NOT NULL,
    "website" VARCHAR(500),
    "primary_social_url" VARCHAR(500),
    "additional_social_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contact_name" VARCHAR(255) NOT NULL,
    "contact_role" VARCHAR(100),
    "contact_email" VARCHAR(255) NOT NULL,
    "contact_phone" VARCHAR(50),
    "management_company" VARCHAR(255),
    "record_label" VARCHAR(255),
    "audience_range" VARCHAR(50),
    "monthly_listener_range" VARCHAR(50),
    "social_following_range" VARCHAR(50),
    "upcoming_release" VARCHAR(255),
    "upcoming_tour_or_event" VARCHAR(255),
    "existing_merchandise" VARCHAR(255),
    "collaboration_description" TEXT NOT NULL,
    "collectible_formats" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "content_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timeline" VARCHAR(100),
    "authorized_confirmation" BOOLEAN,
    "additional_notes" TEXT,
    "lead_status" "LeadStatus" NOT NULL DEFAULT 'new',
    "priority" "LeadPriority" NOT NULL DEFAULT 'unreviewed',
    "assigned_user_id" TEXT,
    "follow_up_at" TIMESTAMP(3),
    "source_page" VARCHAR(255),
    "utm_source" VARCHAR(255),
    "utm_medium" VARCHAR(255),
    "utm_campaign" VARCHAR(255),
    "ip_hash" VARCHAR(64),
    "consent_version" VARCHAR(20) NOT NULL,
    "consent_timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artist_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_leads" (
    "id" TEXT NOT NULL,
    "company_name" VARCHAR(255) NOT NULL,
    "contact_name" VARCHAR(255) NOT NULL,
    "job_title" VARCHAR(150),
    "work_email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(50),
    "country" VARCHAR(100) NOT NULL,
    "partnership_type" VARCHAR(100) NOT NULL,
    "company_website" VARCHAR(500),
    "company_size" VARCHAR(50),
    "linkedin_url" VARCHAR(500),
    "relevant_capabilities" TEXT,
    "company_description" TEXT,
    "desired_timeline" VARCHAR(100),
    "message" TEXT NOT NULL,
    "lead_status" "LeadStatus" NOT NULL DEFAULT 'new',
    "priority" "LeadPriority" NOT NULL DEFAULT 'unreviewed',
    "assigned_user_id" TEXT,
    "follow_up_at" TIMESTAMP(3),
    "source_page" VARCHAR(255),
    "utm_source" VARCHAR(255),
    "utm_medium" VARCHAR(255),
    "utm_campaign" VARCHAR(255),
    "ip_hash" VARCHAR(64),
    "consent_version" VARCHAR(20) NOT NULL,
    "consent_timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "additional_notes" TEXT,
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_subscribers_email_normalized_key" ON "waitlist_subscribers"("email_normalized");

-- CreateIndex
CREATE INDEX "waitlist_subscribers_created_at_idx" ON "waitlist_subscribers"("created_at");

-- CreateIndex
CREATE INDEX "waitlist_subscribers_status_idx" ON "waitlist_subscribers"("status");

-- CreateIndex
CREATE INDEX "contact_submissions_created_at_idx" ON "contact_submissions"("created_at");

-- CreateIndex
CREATE INDEX "contact_submissions_status_idx" ON "contact_submissions"("status");

-- CreateIndex
CREATE INDEX "artist_leads_created_at_idx" ON "artist_leads"("created_at");

-- CreateIndex
CREATE INDEX "artist_leads_lead_status_idx" ON "artist_leads"("lead_status");

-- CreateIndex
CREATE INDEX "partner_leads_created_at_idx" ON "partner_leads"("created_at");

-- CreateIndex
CREATE INDEX "partner_leads_lead_status_idx" ON "partner_leads"("lead_status");
