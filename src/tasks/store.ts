export interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  createdAt: string;
}

const tasks = new Map<string, Task>();
let nextId = 1;

export function createTask(subject: string, description: string): Task {
  const task: Task = {
    id: String(nextId++),
    subject,
    description,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  tasks.set(task.id, task);
  return { ...task };
}

export function updateTask(id: string, updates: Partial<Pick<Task, "status" | "subject" | "description">>): Task | null {
  const task = tasks.get(id);
  if (!task) return null;
  const updated = { ...task, ...updates };
  tasks.set(id, updated);
  return { ...updated };
}

export function getTask(id: string): Task | null {
  const task = tasks.get(id);
  return task ? { ...task } : null;
}

export function listTasks(): Task[] {
  return [...tasks.values()].map((t) => ({ ...t }));
}

export function clearTasks(): void {
  tasks.clear();
  nextId = 1;
}
