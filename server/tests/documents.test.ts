import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { setupTestDB, clearTestDB, teardownTestDB } from './setup.js';

const app = createApp();

describe('Document Management & Authorization API Suite', () => {
  let userAToken: string;
  let userBToken: string;
  let userBEmail: string;

  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();

    // Register User A
    const resA = await request(app).post('/api/auth/register').send({
      name: 'User A',
      email: 'userA@example.com',
      password: 'Password123!',
    });
    userAToken = resA.body.data.token;

    // Register User B
    const resB = await request(app).post('/api/auth/register').send({
      name: 'User B',
      email: 'userB@example.com',
      password: 'Password123!',
    });
    userBToken = resB.body.data.token;
    userBEmail = 'userB@example.com';
  });

  describe('Document Creation & Listing', () => {
    it('creates a new document with owner set to current user', async () => {
      const res = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ title: 'System Design Notes' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.document.title).toBe('System Design Notes');
      expect(res.body.data.document.owner.email).toBe('usera@example.com');
      expect(res.body.data.document.collaborators).toHaveLength(0);
    });

    it('lists only documents accessible to the authenticated user', async () => {
      // User A creates 2 documents
      await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ title: 'Doc A1' });

      await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ title: 'Doc A2' });

      // User B creates 1 document
      await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ title: 'Doc B1' });

      // User A list check
      const resA = await request(app)
        .get('/api/documents')
        .set('Authorization', `Bearer ${userAToken}`);

      expect(resA.status).toBe(200);
      expect(resA.body.data.documents).toHaveLength(2);
      expect(resA.body.data.documents.map((d: any) => d.title)).toContain('Doc A1');
      expect(resA.body.data.documents.map((d: any) => d.title)).toContain('Doc A2');

      // User B list check
      const resB = await request(app)
        .get('/api/documents')
        .set('Authorization', `Bearer ${userBToken}`);

      expect(resB.status).toBe(200);
      expect(resB.body.data.documents).toHaveLength(1);
      expect(resB.body.data.documents[0].title).toBe('Doc B1');
    });
  });

  describe('Document-Level Authorization & Access Enforcement', () => {
    let docAId: string;

    beforeEach(async () => {
      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ title: 'Confidential Strategy' });

      docAId = docRes.body.data.document._id;
    });

    it('allows owner to fetch document metadata', async () => {
      const res = await request(app)
        .get(`/api/documents/${docAId}`)
        .set('Authorization', `Bearer ${userAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isOwner).toBe(true);
      expect(res.body.data.document.title).toBe('Confidential Strategy');
    });

    it('strictly forbids User B from reading User A private document (403 Forbidden)', async () => {
      const res = await request(app)
        .get(`/api/documents/${docAId}`)
        .set('Authorization', `Bearer ${userBToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('strictly forbids User B from renaming User A private document (403 Forbidden)', async () => {
      const res = await request(app)
        .patch(`/api/documents/${docAId}`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ title: 'Hacked Title' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('allows owner to rename document', async () => {
      const res = await request(app)
        .patch(`/api/documents/${docAId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ title: 'Updated Strategy v2' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.document.title).toBe('Updated Strategy v2');
    });
  });

  describe('Collaborator Sharing & Revocation', () => {
    let docId: string;

    beforeEach(async () => {
      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ title: 'Shared Roadmap' });

      docId = docRes.body.data.document._id;
    });

    it('allows owner to grant collaborator access by email', async () => {
      const res = await request(app)
        .post(`/api/documents/${docId}/collaborators`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ email: userBEmail });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.document.collaborators).toHaveLength(1);
      expect(res.body.data.document.collaborators[0].email).toBe(userBEmail.toLowerCase());

      // Now User B can fetch and view the document
      const viewRes = await request(app)
        .get(`/api/documents/${docId}`)
        .set('Authorization', `Bearer ${userBToken}`);

      expect(viewRes.status).toBe(200);
      expect(viewRes.body.data.isOwner).toBe(false);
    });

    it('prevents unauthorized users from adding collaborators (403 Forbidden)', async () => {
      const res = await request(app)
        .post(`/api/documents/${docId}/collaborators`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ email: 'userC@example.com' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('returns 404 when attempting to share with non-existent user email', async () => {
      const res = await request(app)
        .post(`/api/documents/${docId}/collaborators`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ email: 'nobody@example.com' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('allows owner to revoke collaborator access', async () => {
      // First add User B
      const addRes = await request(app)
        .post(`/api/documents/${docId}/collaborators`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ email: userBEmail });

      const userBId = addRes.body.data.document.collaborators[0]._id;

      // Revoke User B
      const deleteRes = await request(app)
        .delete(`/api/documents/${docId}/collaborators/${userBId}`)
        .set('Authorization', `Bearer ${userAToken}`);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.data.document.collaborators).toHaveLength(0);

      // User B can no longer view the document
      const viewRes = await request(app)
        .get(`/api/documents/${docId}`)
        .set('Authorization', `Bearer ${userBToken}`);

      expect(viewRes.status).toBe(403);
    });
  });
});
