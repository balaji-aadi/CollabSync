import { apiRequest } from './client';
import { User } from './auth';

export interface DocumentItem {
  _id: string;
  title: string;
  owner: User;
  collaborators: User[];
  createdAt: string;
  updatedAt: string;
}

export async function fetchDocuments(): Promise<DocumentItem[]> {
  const data = await apiRequest<{ documents: DocumentItem[] }>('/api/documents', {
    method: 'GET',
  });
  return data.documents;
}

export async function fetchDocument(id: string): Promise<{ document: DocumentItem; isOwner: boolean }> {
  return apiRequest<{ document: DocumentItem; isOwner: boolean }>(`/api/documents/${id}`, {
    method: 'GET',
  });
}

export async function createDocument(title: string): Promise<DocumentItem> {
  const data = await apiRequest<{ document: DocumentItem }>('/api/documents', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  return data.document;
}

export async function renameDocument(id: string, title: string): Promise<DocumentItem> {
  const data = await apiRequest<{ document: DocumentItem }>(`/api/documents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
  return data.document;
}

export async function addCollaborator(id: string, email: string): Promise<DocumentItem> {
  const data = await apiRequest<{ document: DocumentItem }>(`/api/documents/${id}/collaborators`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  return data.document;
}

export async function removeCollaborator(id: string, userId: string): Promise<DocumentItem> {
  const data = await apiRequest<{ document: DocumentItem }>(`/api/documents/${id}/collaborators/${userId}`, {
    method: 'DELETE',
  });
  return data.document;
}
