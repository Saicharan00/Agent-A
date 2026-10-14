// Learn area for the UI (F23): decision records and the lesson journal.
import {
  type DecisionCreateRequest,
  type DecisionStatus,
  type DecisionUpdateRequest,
  type LessonCreateRequest,
  type LessonReviewResult,
  type LessonUpdateRequest,
  decisionViewSchema,
  lessonViewSchema,
} from '@agenta/shared';
import { z } from 'zod';
import { apiRequest } from './api';

const enc = encodeURIComponent;

export const learnApi = {
  decisions: (status?: DecisionStatus) =>
    apiRequest('/decisions', z.array(decisionViewSchema), { query: { status } }),
  createDecision: (body: DecisionCreateRequest) =>
    apiRequest('/decisions', decisionViewSchema, { method: 'POST', body }),
  updateDecision: (id: string, body: DecisionUpdateRequest) =>
    apiRequest(`/decisions/${enc(id)}`, decisionViewSchema, { method: 'PATCH', body }),
  lessons: () => apiRequest('/lessons', z.array(lessonViewSchema)),
  createLesson: (body: LessonCreateRequest) =>
    apiRequest('/lessons', lessonViewSchema, { method: 'POST', body }),
  updateLesson: (id: string, body: LessonUpdateRequest) =>
    apiRequest(`/lessons/${enc(id)}`, lessonViewSchema, { method: 'PATCH', body }),
  reviewLesson: (id: string, result: LessonReviewResult) =>
    apiRequest(`/lessons/${enc(id)}/review`, lessonViewSchema, { method: 'POST', body: { result } }),
  deleteLesson: (id: string) => apiRequest(`/lessons/${enc(id)}`, z.unknown(), { method: 'DELETE' }),
};

export const isDue = (nextReviewAt: string | null, now = Date.now()) =>
  nextReviewAt !== null && Date.parse(nextReviewAt) <= now;
