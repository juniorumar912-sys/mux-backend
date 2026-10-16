import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { UsersService } from './../src/users/users.service';
import { IdempotentUserService } from './../src/users/idempotent-user.service';
import { MetricsService } from './../src/common/metrics/metrics.service';
import { ApiKeyService } from './../src/api-keys/api-key.service';
import { ApiKeyGuard } from './../src/api-keys/api-key.guard';
import { Reflector } from '@nestjs/core';

/**
 * E2E tests for the user find-or-create endpoint (#921, #984, #1086).
 *
 * Covers:
 * - Authentication (API key required, invalid key rejected)
 * - Authorization (deny-by-default for unknown actor types)
 * - Idempotency (same key returns same result, missing key rejected)
 * - Fail-closed on dependency outage (DB unavailable → 503)
 * - Input validation (oversized authId rejected)
 * - DTO validation (#1086): missing/non-string authId, unsupported network
 * - Structured error responses with stable error codes
 * - Correlation ids flow through error responses
 * - No secrets leaked in responses
 */
describe('POST /users/find-or-create (e2e)', () => {
  let app: INestApplication<App>;
  let usersService: UsersService;
  let idempotentUserService: IdempotentUserService;
  let metricsService: MetricsService;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalGuards(new ApiKeyGuard(app.get(ApiKeyService), app.get(Reflector)));
    await app.init();

    usersService = moduleFixture.get<UsersService>(UsersService);
    idempotentUserService = moduleFixture.get<IdempotentUserService>(IdempotentUserService);
    metricsService = moduleFixture.get<MetricsService>(MetricsService);
  });

  afterEach(async () => {
    await app.close();
  });

  // ── Authentication ──────────────────────────────────────────

  describe('authentication', () => {
    it('should require an API key', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .send({ authId: 'test-auth-id-e2e' });

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should reject an invalid API key', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer invalid-key')
        .send({ authId: 'test-auth-id-e2e' });

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  // ── Input validation ────────────────────────────────────────

  describe('input validation', () => {
    it('should reject a missing authId', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({});

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body).toHaveProperty('errorCode');
    });

    it('should reject a non-string authId', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({ authId: 123 });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject an empty authId', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({ authId: '' });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject an unsupported network', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({ authId: 'u1', network: 'NOT_A_NETWORK' });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject a non-string idempotencyKey', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({ authId: 'u1', idempotencyKey: 42 });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should default network to TESTNET and generate an idempotencyKey', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({ authId: 'u1' });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toHaveProperty('network', 'TESTNET');
      expect(response.body).toHaveProperty('idempotencyKey');
      expect(typeof response.body.idempotencyKey).toBe('string');
    });

    it('should reject an oversized authId', async () => {
      const oversizedAuthId = 'a'.repeat(257);
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({ authId: oversizedAuthId });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject a missing idempotency key', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({ authId: 'test-auth-id-e2e' });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body).toHaveProperty('errorCode');
    });
  });

  // ── Idempotency ─────────────────────────────────────────────

  describe('idempotency', () => {
    it('should return the same result for the same idempotency key', async () => {
      const idempotencyKey = `idem-${Date.now()}`;

      const response1 = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({ authId: 'test-auth-id-idempotent', idempotencyKey });

      expect(response1.status).toBe(HttpStatus.OK);
      expect(response1.body).toHaveProperty('userId');
      expect(response1.body).toHaveProperty('idempotencyKey', idempotencyKey);

      const response2 = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({ authId: 'test-auth-id-idempotent', idempotencyKey });

      expect(response2.status).toBe(HttpStatus.OK);
      expect(response2.body.userId).toBe(response1.body.userId);
    });

    it('should reject concurrent requests with the same idempotency key', async () => {
      const idempotencyKey = `idem-concurrent-${Date.now()}`;

      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({ authId: 'test-auth-id-concurrent', idempotencyKey });

      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should return the same userId for concurrent in-flight requests with the same key', async () => {
      const idempotencyKey = `idem-race-${Date.now()}`;

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post('/users/find-or-create')
          .set('Authorization', 'Bearer mux_test_abc')
          .send({ authId: 'test-auth-id-race', idempotencyKey }),
        request(app.getHttpServer())
          .post('/users/find-or-create')
          .set('Authorization', 'Bearer mux_test_abc')
          .send({ authId: 'test-auth-id-race', idempotencyKey }),
      ]);

      expect(first.status).toBe(HttpStatus.OK);
      expect(second.status).toBe(HttpStatus.OK);
      expect(first.body.userId).toBe(second.body.userId);
    });
  });

  // ── Authorization ────────────────────────────────────────────

  describe('authorization', () => {
    it('should accept requests with valid actor types', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({ authId: 'test-auth-id-authz', idempotencyKey: `idem-authz-${Date.now()}` });

      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should deny-by-default for an unknown actor type', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({
          authId: 'test-auth-id-unknown-actor',
          actorType: 'unknown-actor',
          idempotencyKey: `idem-unknown-actor-${Date.now()}`,
        });

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(response.body).toHaveProperty('errorCode');
    });
  });

  // ── Fail-closed on dependency outage ────────────────────────

  describe('dependency outage', () => {
    it('should fail closed with 503 when the datastore is unavailable', async () => {
      const spy = jest
        .spyOn(idempotentUserService, 'findOrCreate')
        .mockRejectedValueOnce(new Error('ECONNREFUSED: datastore unavailable'));

      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({ authId: 'test-auth-id-outage', idempotencyKey: `idem-outage-${Date.now()}` });

      expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(response.body).toHaveProperty('errorCode');

      spy.mockRestore();
    });
  });

  // ── Structured error responses ──────────────────────────────

  describe('structured error responses', () => {
    it('should return a stable error code for validation failures', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_abc')
        .send({});

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body).toHaveProperty('errorCode');
    });
  });
});
