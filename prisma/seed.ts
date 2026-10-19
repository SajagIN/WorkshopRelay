/**
 * Seed: synthetic members, demo identities (tokens from env), and one sample
 * workshop with a registration + pending confirmation so the dashboard and
 * demo have meaningful state on first run.
 *
 * Idempotent: safe to run repeatedly (stable derived IDs + upserts).
 */
import { createDb } from '../src/db/client';
import { parseConfig } from '../src/shared/config';
import { createLogger } from '../src/shared/logger';
import { uuidV5 } from '../src/shared/uuid';
import {
  buildConfirmationPayload,
  confirmationDedupeKey,
} from '../src/domain/events';
import { PAYLOAD_VERSION } from '../src/domain/types';

const config = parseConfig();
const logger = createLogger({ level: config.logLevel, base: { component: 'seed' } });

const ORGANIZER_ID = uuidV5('seed:organizer');
const MEMBER_IDS: Record<string, string> = {
  alice: uuidV5('seed:member:alice'),
  bob: uuidV5('seed:member:bob'),
  carol: uuidV5('seed:member:carol'),
  dave: uuidV5('seed:member:dave'),
};

const MEMBER_PROFILES: Record<
  string,
  { displayName: string; notificationAddress: string }
> = {
  alice: { displayName: 'Alice Chen', notificationAddress: 'alice@synthetic.invalid' },
  bob: { displayName: 'Bob Martinez', notificationAddress: 'bob@synthetic.invalid' },
  carol: { displayName: 'Carol Osei', notificationAddress: 'carol@synthetic.invalid' },
  dave: { displayName: 'Dave Kim', notificationAddress: 'dave@synthetic.invalid' },
};

const SAMPLE_WORKSHOP_ID = uuidV5('seed:workshop:typescript-deep-dive');
const SAMPLE_REGISTRATION_ID = uuidV5('seed:registration:alice:typescript-deep-dive');

async function main(): Promise<void> {
  const handle = createDb(config.databaseUrl);
  const { db } = handle;

  try {
    // --- Members -----------------------------------------------------------
    for (const [label, id] of Object.entries(MEMBER_IDS)) {
      const profile = MEMBER_PROFILES[label];
      await db.member.upsert({
        where: { id },
        update: { displayName: profile.displayName, notificationAddress: profile.notificationAddress },
        create: {
          id,
          displayName: profile.displayName,
          notificationAddress: profile.notificationAddress,
        },
      });
    }

    // --- Demo identities ----------------------------------------------------
    await db.demoIdentity.upsert({
      where: { token: config.organizerToken },
      update: { label: 'Organizer', role: 'ORGANIZER', memberId: null },
      create: { token: config.organizerToken, label: 'Organizer', role: 'ORGANIZER', memberId: null },
    });

    for (const entry of config.memberTokens) {
      const memberId = MEMBER_IDS[entry.label.toLowerCase()];
      if (!memberId) {
        throw new Error(
          `MEMBER_TOKENS label "${entry.label}" has no seeded member profile. ` +
            `Known labels: ${Object.keys(MEMBER_IDS).join(', ')}`,
        );
      }
      await db.demoIdentity.upsert({
        where: { token: entry.token },
        update: { label: entry.label, role: 'MEMBER', memberId },
        create: { token: entry.token, label: entry.label, role: 'MEMBER', memberId },
      });
    }

    // --- Sample workshop + one registration + confirmation event ------------
    const scheduledAt = new Date('2026-11-25T09:00:00Z');
    await db.workshop.upsert({
      where: { id: SAMPLE_WORKSHOP_ID },
      update: {},
      create: {
        id: SAMPLE_WORKSHOP_ID,
        title: 'TypeScript Deep Dive',
        description:
          'Generics, conditional types, and safe concurrency patterns — seeded sample workshop.',
        scheduledAt,
        status: 'ACTIVE',
        createdBy: 'Organizer',
      },
    });

    const aliceId = MEMBER_IDS['alice'];
    await db.registration.upsert({
      where: { workshopId_memberId: { workshopId: SAMPLE_WORKSHOP_ID, memberId: aliceId } },
      update: {},
      create: {
        id: SAMPLE_REGISTRATION_ID,
        workshopId: SAMPLE_WORKSHOP_ID,
        memberId: aliceId,
      },
    });

    const confirmationEventId = uuidV5('seed:event:confirmation:alice:typescript-deep-dive');
    const payload = buildConfirmationPayload({
      workshopId: SAMPLE_WORKSHOP_ID,
      title: 'TypeScript Deep Dive',
      scheduledAt: scheduledAt.toISOString(),
      memberId: aliceId,
      memberName: MEMBER_PROFILES['alice'].displayName,
      notificationAddress: MEMBER_PROFILES['alice'].notificationAddress,
      registeredAt: new Date().toISOString(),
    });

    await db.notificationEvent.upsert({
      where: { id: confirmationEventId },
      update: {},
      create: {
        id: confirmationEventId,
        dedupeKey: confirmationDedupeKey(SAMPLE_REGISTRATION_ID),
        type: 'REGISTRATION_CONFIRMED',
        recipientId: aliceId,
        workshopId: SAMPLE_WORKSHOP_ID,
        registrationId: SAMPLE_REGISTRATION_ID,
        payload: payload as object,
        status: 'PENDING',
        attemptCount: 0,
        nextAttemptAt: new Date(),
      },
    });

    logger.info('Seed complete', {
      members: Object.keys(MEMBER_IDS),
      sampleWorkshopId: SAMPLE_WORKSHOP_ID,
      payloadVersion: PAYLOAD_VERSION,
      organizerId: ORGANIZER_ID,
    });

    process.stdout.write(
      '\nSeeded demo identities (dev-only tokens, from .env):\n' +
        `  Organizer : token "${config.organizerToken}"\n` +
        config.memberTokens
          .map((m) => `  ${m.label.padEnd(9)} : token "${m.token}" (member ${MEMBER_IDS[m.label.toLowerCase()]})`)
          .join('\n') +
        '\n',
    );
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  logger.error('Seed failed', { err });
  process.exitCode = 1;
});
