import type { Metadata } from 'next';
import { TaskBoard } from '@/components/tasks/task-board';

export const metadata: Metadata = { title: 'Tasks' };

export default function TasksPage() {
  return <TaskBoard />;
}
