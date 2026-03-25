/**
 * Skills system — agent-managed procedural knowledge.
 *
 * Skills capture "how to do a specific type of task" from proven experience.
 * Stored as SKILL.md files in ~/.her/data/skills/<name>/SKILL.md
 *
 * Format:
 *   ---
 *   name: skill-name
 *   description: When to use this skill
 *   tags: [tag1, tag2]
 *   version: 1
 *   created: ISO date
 *   updated: ISO date
 *   ---
 *   # Title
 *   Full markdown instructions...
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./utils");

const SKILLS_DIR = path.join(DATA_DIR, "skills");

// Ensure dir exists
if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });

const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME_LEN = 64;

// ── Parse SKILL.md frontmatter ──

function parseSkillMd(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  try {
    const meta = {};
    const lines = match[1].split("\n");
    for (const line of lines) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) {
        let val = kv[2].trim();
        // Parse arrays like [a, b, c]
        if (val.startsWith("[") && val.endsWith("]")) {
          val = val.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
        }
        // Parse numbers
        else if (/^\d+$/.test(val)) val = parseInt(val);
        meta[kv[1]] = val;
      }
    }
    return { meta, body: match[2].trim() };
  } catch (e) {
    return { meta: {}, body: content };
  }
}

function buildSkillMd(meta, body) {
  const lines = [];
  lines.push("---");
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(", ")}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(body);
  return lines.join("\n");
}

// ── CRUD ──

function validateName(name) {
  if (!name || typeof name !== "string") return "Skill name is required";
  if (name.length > MAX_NAME_LEN) return `Name too long (max ${MAX_NAME_LEN} chars)`;
  if (!VALID_NAME_RE.test(name)) return "Name must be lowercase alphanumeric with hyphens/dots/underscores, starting with alphanumeric";
  return null;
}

function getSkillDir(name) {
  return path.join(SKILLS_DIR, name);
}

function getSkillPath(name) {
  return path.join(SKILLS_DIR, name, "SKILL.md");
}

function skillExists(name) {
  return fs.existsSync(getSkillPath(name));
}

function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    try {
      const content = fs.readFileSync(skillFile, "utf-8");
      const { meta } = parseSkillMd(content);
      skills.push({
        name: meta.name || entry.name,
        description: meta.description || "",
        tags: meta.tags || [],
        version: meta.version || 1,
        updated: meta.updated || meta.created || "",
      });
    } catch (e) {
      skills.push({ name: entry.name, description: "(parse error)", tags: [], version: 0 });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function getSkill(name) {
  const skillFile = getSkillPath(name);
  if (!fs.existsSync(skillFile)) return null;
  const content = fs.readFileSync(skillFile, "utf-8");
  return parseSkillMd(content);
}

function createSkill(name, description, body, tags = []) {
  const err = validateName(name);
  if (err) return { error: err };
  if (skillExists(name)) return { error: `Skill "${name}" already exists. Use edit or patch.` };

  const dir = getSkillDir(name);
  fs.mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const meta = { name, description, tags, version: 1, created: now, updated: now };
  const content = buildSkillMd(meta, body);
  fs.writeFileSync(getSkillPath(name), content, "utf-8");

  console.log(`[Skills] Created: ${name}`);
  return { ok: true, message: `Skill "${name}" created.` };
}

function editSkill(name, description, body, tags) {
  if (!skillExists(name)) return { error: `Skill "${name}" not found.` };

  const existing = getSkill(name);
  const meta = existing.meta;
  if (description) meta.description = description;
  if (tags) meta.tags = tags;
  meta.version = (meta.version || 0) + 1;
  meta.updated = new Date().toISOString();

  const content = buildSkillMd(meta, body);
  fs.writeFileSync(getSkillPath(name), content, "utf-8");

  console.log(`[Skills] Edited: ${name} (v${meta.version})`);
  return { ok: true, message: `Skill "${name}" updated to v${meta.version}.` };
}

function patchSkill(name, oldText, newText) {
  if (!skillExists(name)) return { error: `Skill "${name}" not found.` };

  const content = fs.readFileSync(getSkillPath(name), "utf-8");
  if (!content.includes(oldText)) {
    return { error: "old_text not found in skill. Use skill_view to see current content." };
  }
  const count = content.split(oldText).length - 1;
  if (count > 1) {
    return { error: `old_text found ${count} times — must be unique.` };
  }

  const newContent = content.replace(oldText, newText);

  // Bump version
  const { meta } = parseSkillMd(newContent);
  meta.version = (meta.version || 0) + 1;
  meta.updated = new Date().toISOString();
  const final = buildSkillMd(meta, parseSkillMd(newContent).body);

  fs.writeFileSync(getSkillPath(name), final, "utf-8");
  console.log(`[Skills] Patched: ${name} (v${meta.version})`);
  return { ok: true, message: `Skill "${name}" patched (v${meta.version}).` };
}

function deleteSkill(name) {
  const dir = getSkillDir(name);
  if (!fs.existsSync(dir)) return { error: `Skill "${name}" not found.` };
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[Skills] Deleted: ${name}`);
  return { ok: true, message: `Skill "${name}" deleted.` };
}

// ── For system prompt injection ──

function getSkillSummaries() {
  const skills = listSkills();
  if (skills.length === 0) return "";
  return skills.map(s => `- **${s.name}**: ${s.description}${s.tags.length ? ` [${s.tags.join(", ")}]` : ""}`).join("\n");
}

module.exports = {
  listSkills, getSkill, createSkill, editSkill, patchSkill, deleteSkill,
  getSkillSummaries, skillExists, SKILLS_DIR,
};
