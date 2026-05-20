export interface Skill {
  name: string;
  description: string;
  content: string;
  aliases?: string[];
}

const skills = new Map<string, Skill>();

export function registerSkill(skill: Skill): void {
  skills.set(skill.name, skill);
  if (skill.aliases) {
    for (const alias of skill.aliases) {
      skills.set(alias, skill);
    }
  }
}

export function getSkill(name: string): Skill | undefined {
  return skills.get(name);
}

export function listSkills(): Skill[] {
  const seen = new Set<string>();
  const result: Skill[] = [];
  for (const skill of skills.values()) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      result.push(skill);
    }
  }
  return result;
}

export function clearSkills(): void {
  skills.clear();
}
