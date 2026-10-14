// Learn area for the UI (F23): decision records and the lesson journal.
import {
  type DecisionCreateRequest,
  type DecisionStatus,
  type DecisionUpdateRequest,
  type CarryOverBriefRequest,
  type LessonCreateRequest,
  type LessonReviewResult,
  type LessonUpdateRequest,
  decisionViewSchema,
  handoffBriefSchema,
  learnRequestResponseSchema,
  lessonViewSchema,
  workSplitSchema,
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
  workSplit: (weeks = 8) => apiRequest('/learn/work-split', workSplitSchema, { query: { weeks } }),
  weeklyReview: () => apiRequest('/learn/weekly-review', learnRequestResponseSchema, { method: 'POST' }),
  carryOverBrief: (body: CarryOverBriefRequest) =>
    apiRequest('/learn/carry-over-brief', learnRequestResponseSchema, { method: 'POST', body }),
  briefs: () => apiRequest('/learn/briefs', z.array(handoffBriefSchema)),
  askWhy: (threadId: string, messageId: string) =>
    apiRequest(`/threads/${enc(threadId)}/messages/${enc(messageId)}/ask-why`, z.unknown(), {
      method: 'POST',
    }),
};

export const isDue = (nextReviewAt: string | null, now = Date.now()) =>
  nextReviewAt !== null && Date.parse(nextReviewAt) <= now;
