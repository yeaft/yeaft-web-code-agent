/**
 * dream-prompt.js — Dream prompt templates for each phase
 *
 * Dream has 5 phases:
 *   Phase 1: Orient  — assess current memory state
 *   Phase 2: Gather  — collect recent context
 *   Phase 3: Merge   — combine duplicates, update outdated
 *   Phase 4: Prune   — remove stale/low-value entries
 *   Phase 5: Promote — extract patterns, update profile
 *
 * Reference: yeaft-unify-core-systems.md §3.3
 */

/**
 * Build the Orient phase prompt (Phase 1).
 * The LLM assesses the current memory state and identifies issues.
 *
 * @param {{ memorySummary: string, profileContent: string, entryCount: number }} context
 * @returns {string}
 */
export function buildOrientPrompt({ memorySummary, profileContent, entryCount }) {
  return `You are in Dream Mode — Phase 1: Orient.

Your task is to assess the current state of the memory store and identify what needs attention.

## Current Memory State

${memorySummary}

## MEMORY.md (User Profile)

${profileContent || '(empty)'}

## Assessment Instructions

Review the memory state and provide:
1. **Redundancies**: Are there entries that overlap or say the same thing?
2. **Outdated info**: Are there entries that might be stale or no longer relevant?
3. **Gaps**: Is there important context missing from MEMORY.md?
4. **Quality**: Are entries well-categorized (kind, scope, tags)?

Return your assessment as JSON:
{
  "redundantGroups": [["entry-a", "entry-b"]],
  "potentiallyStale": ["entry-name-1"],
  "profileGaps": ["missing X context"],
  "qualityIssues": ["entry-y has wrong kind"],
  "overallHealth": "good" | "needs-attention" | "poor",
  "suggestedActions": ["merge entries about X", "prune stale context entries"]
}

Return ONLY valid JSON, no other text.`;
}

/**
 * Build the Gather phase prompt (Phase 2).
 * Collects recent compact summaries and completed task summaries.
 *
 * @param {{ recentCompact: string, completedTasks: object[], orientResult: object }} context
 * @returns {string}
 */
export function buildGatherPrompt({ recentCompact, completedTasks, orientResult }) {
  const taskSummaries = completedTasks.length > 0
    ? completedTasks.map(t => `- [${t.id}] ${t.description}: ${t.summary || '(no summary)'}`).join('\n')
    : '(no recently completed tasks)';

  return `You are in Dream Mode — Phase 2: Gather.

Your task is to identify what new information should be incorporated into long-term memory.

## Recent Conversation Summary (compact.md)

${recentCompact || '(no recent summaries)'}

## Recently Completed Tasks

${taskSummaries}

## Orient Assessment

${JSON.stringify(orientResult, null, 2)}

## Instructions

From the recent conversations and tasks, identify:
1. **New facts** worth remembering (project structure, tech decisions)
2. **New preferences** expressed by the user
3. **New skills/lessons** learned during tasks
4. **Context updates** (project progress, status changes)

Return as JSON:
{
  "newEntries": [
    { "name": "slug-name", "kind": "fact|preference|skill|lesson|context|relation", "scope": "path", "tags": ["tag1", "tag2"], "importance": "high|normal|low", "content": "description" }
  ],
  "updatesToExisting": [
    { "entryName": "existing-slug", "updates": { "content": "updated text", "tags": ["new-tag"] } }
  ]
}

Return ONLY valid JSON, no other text.`;
}

/**
 * Build the Merge phase prompt (Phase 3).
 *
 * @param {{ duplicateGroups: object[][], gatherResult: object }} context
 * @returns {string}
 */
export function buildMergePrompt({ duplicateGroups, gatherResult }) {
  const groupDescriptions = duplicateGroups.map((group, i) => {
    const entries = group.map(e =>
      `  - [${e.name}] kind=${e.kind}, scope=${e.scope}, tags=[${(e.tags || []).join(', ')}]\n    ${(e.content || '').slice(0, 200)}`
    ).join('\n');
    return `Group ${i + 1}:\n${entries}`;
  }).join('\n\n');

  return `You are in Dream Mode — Phase 3: Merge.

Your task is to merge duplicate/overlapping entries into single, richer entries.

## Potentially Duplicate Groups

${groupDescriptions || '(no duplicates detected)'}

## New Entries from Gather Phase

${JSON.stringify(gatherResult?.newEntries || [], null, 2)}

## Instructions

For each duplicate group:
1. Decide if they should be merged (combine info) or kept separate (different enough)
2. For merges, create a single entry that preserves all important info from both
3. List which old entries should be deleted after merge

Also process the new entries from Gather — check if any overlap with existing entries.

Return as JSON:
{
  "merges": [
    {
      "merged": { "name": "new-slug", "kind": "...", "scope": "...", "tags": [], "importance": "...", "content": "..." },
      "deleteOriginals": ["old-entry-1", "old-entry-2"]
    }
  ],
  "newEntries": [
    { "name": "...", "kind": "...", "scope": "...", "tags": [], "importance": "...", "content": "..." }
  ],
  "updates": [
    { "entryName": "existing-slug", "updates": { "content": "updated text" } }
  ]
}

Return ONLY valid JSON, no other text.`;
}

/**
 * Build the Prune phase prompt (Phase 4).
 *
 * @param {{ staleEntries: object[], entryCount: number, maxEntries: number }} context
 * @returns {string}
 */
export function buildPrunePrompt({ staleEntries, entryCount, maxEntries }) {
  const staleDescriptions = staleEntries.map(e =>
    `- [${e.name}] kind=${e.kind}, scope=${e.scope}, freq=${e.frequency || 1}, days_since_update=${e._daysSinceUpdate}\n  ${(e.content || '').slice(0, 150)}`
  ).join('\n');

  return `You are in Dream Mode — Phase 4: Prune.

Your task is to remove stale, low-value, or redundant entries.

## Potentially Stale Entries (${staleEntries.length} found)

${staleDescriptions || '(none detected)'}

## Capacity

Current entries: ${entryCount}
Maximum allowed: ${maxEntries}
${entryCount > maxEntries ? `⚠️ OVER CAPACITY by ${entryCount - maxEntries} entries — must prune aggressively` : 'Within capacity'}

## Prune Guidelines

Delete entries that are:
- **Outdated context**: Project status from weeks ago
- **Never recalled**: frequency=1 and old — nobody needs it
- **Too vague**: "user mentioned something about X" without useful detail
- **Redundant with profile**: If MEMORY.md already captures it
- **Re-derivable**: Info that can be obtained by running a command (e.g., "Node version is 20")

KEEP entries that are:
- High importance or high frequency
- Recent preferences or lessons
- Facts about project structure (hard to re-discover)

Return as JSON:
{
  "toDelete": ["entry-name-1", "entry-name-2"],
  "reasoning": {
    "entry-name-1": "outdated context from 45 days ago",
    "entry-name-2": "never recalled, too vague"
  }
}

Return ONLY valid JSON, no other text.`;
}

/**
 * Build the Promote phase prompt (Phase 5).
 *
 * @param {{ entries: object[], profileContent: string, scopesSummary: string }} context
 * @returns {string}
 */
export function buildPromotePrompt({ entries, profileContent, scopesSummary }) {
  // Find entries that might form patterns
  const highFreq = entries
    .filter(e => (e.frequency || 1) >= 3)
    .map(e => `- [${e.name}] kind=${e.kind}, freq=${e.frequency}, scope=${e.scope}: ${(e.content || '').slice(0, 150)}`)
    .join('\n');

  const lessons = entries
    .filter(e => e.kind === 'lesson')
    .map(e => `- [${e.name}] scope=${e.scope}: ${(e.content || '').slice(0, 150)}`)
    .join('\n');

  return `You are in Dream Mode — Phase 5: Promote.

Your task is to identify patterns and update the user profile.

## High-Frequency Entries (recalled ≥3 times)

${highFreq || '(none)'}

## All Lessons

${lessons || '(none)'}

## Current MEMORY.md Profile

${profileContent || '(empty)'}

## Scopes

${scopesSummary}

## Instructions

1. **Pattern promotion**: If multiple entries share a pattern, create a higher-level insight
   - Example: 3 entries about "user corrects indentation" → 1 preference: "default to 2-space indent"
2. **Profile update**: Update MEMORY.md sections based on accumulated knowledge
   - Keep MEMORY.md under 200 lines
   - Sections: Facts, Preferences, Project Context, Skills, Lessons
3. **Scope promotion**: If a lesson applies across projects, promote scope to parent or global

Return as JSON:
{
  "profileUpdates": {
    "Facts": ["- New fact line 1"],
    "Preferences": ["- New preference line"],
    "Project Context": [],
    "Skills": [],
    "Lessons": []
  },
  "promotedEntries": [
    { "name": "...", "kind": "...", "scope": "global", "tags": [], "importance": "high", "content": "..." }
  ],
  "entriesToDelete": ["entry-that-was-promoted-to-profile"]
}

Return ONLY valid JSON, no other text.`;
}
