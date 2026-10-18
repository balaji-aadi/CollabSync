import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { setupTestDB, clearTestDB, teardownTestDB } from './setup.js';
import { env } from '../src/config/env.js';

const app = createApp();

describe('Authentication API Suite', () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
  });

  describe('POST /api/auth/register', () => {
    it('successfully registers a new user with hashed password and returns token + cookie', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          name: 'Alice Developer',
          email: 'alice@example.com',
          password: 'Password123!',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user).toBeDefined();
      expect(res.body.data.user.email).toBe('alice@example.com');
      expect(res.body.data.user.name).toBe('Alice Developer');
      expect(res.body.data.user.password).toBeUndefined(); // Never expose password
      expect(res.body.data.token).toBeDefined();

      // Check cookie header
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies.some((c: string) => c.includes(env.COOKIE_NAME))).toBe(true);
    });

    it('rejects duplicate email registration with 409 Conflict', async () => {
      // First registration
      await request(app)
        .post('/api/auth/register')
        .send({
          name: 'Bob Original',
          email: 'bob@example.com',
          password: 'Password123!',
        });

      // Second registration with duplicate email
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          name: 'Bob Imposter',
          email: 'bob@example.com',
          password: 'AnotherPassword456',
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('rejects invalid email and short password with 400 Validation Error', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          name: 'A',
          email: 'not-an-email',
          password: '123',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await request(app)
        .post('/api/auth/register')
        .send({
          name: 'Charlie Test',
          email: 'charlie@example.com',
          password: 'SecretPassword99',
        });
    });

    it('successfully logs in with valid credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'charlie@example.com',
          password: 'SecretPassword99',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe('charlie@example.com');
      expect(res.body.data.token).toBeDefined();
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('rejects login with incorrect password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'charlie@example.com',
          password: 'WrongPassword!',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects login for non-existent email', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'ghost@example.com',
          password: 'SecretPassword99',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('GET /api/auth/me and Session Handling', () => {
    it('returns current user session when valid Bearer token is provided', async () => {
      const registerRes = await request(app)
        .post('/api/auth/register')
        .send({
          name: 'Diana User',
          email: 'diana@example.com',
          password: 'Password123!',
        });

      const token = registerRes.body.data.token;

      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body.success).toBe(true);
      expect(meRes.body.data.user.email).toBe('diana@example.com');
    });

    it('returns current user session when valid cookie is provided', async () => {
      const registerRes = await request(app)
        .post('/api/auth/register')
        .send({
          name: 'Edward User',
          email: 'edward@example.com',
          password: 'Password123!',
        });

      const cookie = registerRes.headers['set-cookie'];

      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', cookie);

      expect(meRes.status).toBe(200);
      expect(meRes.body.success).toBe(true);
      expect(meRes.body.data.user.email).toBe('edward@example.com');
    });

    it('rejects request without token or cookie with 401 UNAUTHORIZED', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects request with forged/invalid token with 401 INVALID_TOKEN', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer forged.token.signature');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
    });

    it('clears session cookie on logout', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      // Ensure cookie expiration or clearance
      expect(cookies.some((c: string) => c.includes(`${env.COOKIE_NAME}=;`))).toBe(true);
    });
  });
});
