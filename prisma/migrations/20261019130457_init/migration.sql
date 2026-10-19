-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ORGANIZER', 'MEMBER');

-- CreateEnum
CREATE TYPE "WorkshopStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationEventType" AS ENUM ('REGISTRATION_CONFIRMED', 'WORKSHOP_CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('SUCCESS', 'RETRY_SCHEDULED', 'NEEDS_ATTENTION', 'STALE_LEASE');

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "notificationAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoIdentity" (
    "token" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "memberId" TEXT,

    CONSTRAINT "DemoIdentity_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "Workshop" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "WorkshopStatus" NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMPTZ(3),

    CONSTRAINT "Workshop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Registration" (
    "id" TEXT NOT NULL,
    "workshopId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationEvent" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "type" "NotificationEventType" NOT NULL,
    "recipientId" TEXT NOT NULL,
    "workshopId" TEXT NOT NULL,
    "registrationId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "NotificationEventStatus" NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "leaseUntil" TIMESTAMPTZ(3),
    "leaseToken" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMPTZ(3),

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationAttempt" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "outcome" "AttemptOutcome",
    "httpStatus" INTEGER,
    "error" TEXT,

    CONSTRAINT "NotificationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockDeliveryReceipt" (
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockDeliveryReceipt_pkey" PRIMARY KEY ("idempotencyKey")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "workerId" TEXT NOT NULL,
    "pid" INTEGER,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("workerId")
);

-- CreateIndex
CREATE UNIQUE INDEX "DemoIdentity_memberId_key" ON "DemoIdentity"("memberId");

-- CreateIndex
CREATE INDEX "Workshop_status_scheduledAt_idx" ON "Workshop"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Registration_memberId_idx" ON "Registration"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Registration_workshopId_memberId_key" ON "Registration"("workshopId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationEvent_dedupeKey_key" ON "NotificationEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationEvent_status_nextAttemptAt_idx" ON "NotificationEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationEvent_status_leaseUntil_idx" ON "NotificationEvent"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationAttempt_eventId_attemptNumber_key" ON "NotificationAttempt"("eventId", "attemptNumber");

-- CreateIndex
CREATE INDEX "MockDeliveryReceipt_receivedAt_idx" ON "MockDeliveryReceipt"("receivedAt");

-- AddForeignKey
ALTER TABLE "DemoIdentity" ADD CONSTRAINT "DemoIdentity_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_workshopId_fkey" FOREIGN KEY ("workshopId") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_workshopId_fkey" FOREIGN KEY ("workshopId") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationAttempt" ADD CONSTRAINT "NotificationAttempt_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "NotificationEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
