/**
 * Conductor — Task Runner (Bridge Layer)
 *
 * Bridges the gap between Conductor Claude (task creation) and
 * Orchestrator (state machine) + Actor (Claude instances).
 *
 * Responsibilities:
 * 1. Create actorManager adapter that translates Orchestrator's interface
 *    to Actor module's actual parameter format
 * 2. Instantiate Orchestrator and start task execution
 * 3. Relay status changes and actor output to frontend via UI messages
 * 4. Handle task completion / failure cleanup
 */
import { createOrchestrator } from './orchestrator.js';
import {
  createActor, sendToActor, releaseActor, releaseAllActors
} from './actor.js';
import { getTaskDir, updateTaskInState } from './persistence.js';
import {
  sendConductorMessage, sendConductorOutput, sendStatusUpdate
} from './ui-messages.js';
import { READ_WRITE_SPECIALTIES } from './worktree.js';

// =====================================================================
// Per-task Orchestrator registry
// =====================================================================

/** @type {Map<string, Orchestrator>} taskId → Orchestrator */
const orchestrators = new Map();

/**
 * Get an active orchestrator for a task
 * @param {string} taskId
 * @returns {Orchestrator|null}
 */
export function getOrchestrator(taskId) {
  return orchestrators.get(taskId) || null;
}

// =====================================================================
// ActorManager Adapter
// =====================================================================

/**
 * Create an actorManager adapter that translates Orchestrator's
 * createActor(persona, specialty, context) interface into Actor module's
 * createActor({ personaId, specialtyId, ... }) format.
 *
 * Orchestrator calls:
 *   actorManager.createActor(
 *     { id: personaId, name: personaName },
 *     specialty,        // string like 'coding', 'planning', etc.
 *     { taskId, actorInstanceId, instruction, workDir, memoryPath, ... }
 *   ) → Promise<ActorResult>
 *
 * Actor.js expects:
 *   createActor({
 *     personaId, specialtyId, taskId, taskDir, taskContext,
 *     worktreePath, onOutput, onComplete, onError
 *   }) → Promise<ActorInstance>
 *
 * The adapter wraps actor creation + message sending + result collection
 * into a single Promise<ActorResult> that the Orchestrator awaits.
 */
function createActorManagerAdapter(conductor, taskEntry) {
  const { taskId, workDir, worktreePath } = taskEntry;
  const taskDir = getTaskDir(workDir, taskId);

  return {
    /**
     * Create an actor, send it instructions, and wait for its result.
     * @returns {Promise<ActorResult>}
     */
    async createActor(persona, specialty, context) {
      const actorWorktreePath = READ_WRITE_SPECIALTIES.has(specialty)
        ? worktreePath
        : null;

      // Create a deferred promise for actor completion
      let resolveResult, rejectResult;
      const resultPromise = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });

      const instance = await createActor({
        personaId: persona.id,
        specialtyId: specialty,
        taskId,
        taskDir,
        taskContext: {
          description: taskEntry.description || '',
          instruction: context.instruction || context.description || '',
          memoryPath: context.memoryPath || null,
          planPath: context.planPath || null,
          scenario: taskEntry.scenario,
          workDir
        },
        threadId: context.threadId || null,
        worktreePath: actorWorktreePath,
        onOutput: (instanceId, message) => {
          // Relay actor output to frontend in real-time
          sendConductorOutput(conductor, 'text', message, {
            taskId,
            persona: persona.name || persona.id,
            specialty
          });
        },
        onComplete: (instanceId, result) => {
          console.log(`[TaskRunner] Actor ${instanceId} completed for task ${taskId}`);

          // Accumulate actor cost into conductor totals
          if (result.costUsd) conductor.costUsd += result.costUsd;
          if (result.inputTokens) conductor.totalInputTokens += result.inputTokens;
          if (result.outputTokens) conductor.totalOutputTokens += result.outputTokens;

          // Update tracking: decrement active count
          if (taskEntry.activeActors) {
            const idx = taskEntry.activeActors.indexOf(instanceId);
            if (idx !== -1) taskEntry.activeActors.splice(idx, 1);
          }
          conductor.activeClaudes = Math.max(0, (conductor.activeClaudes || 1) - 1);
          sendStatusUpdate(conductor);

          // Release actor from registry to prevent memory leak
          releaseActor(taskId, instanceId).catch(e =>
            console.warn(`[TaskRunner] Failed to auto-release actor ${instanceId}:`, e.message)
          );

          resolveResult(result);
        },
        onError: (instanceId, error) => {
          console.error(`[TaskRunner] Actor ${instanceId} failed for task ${taskId}:`, error.message);

          // Update tracking: decrement active count
          if (taskEntry.activeActors) {
            const idx = taskEntry.activeActors.indexOf(instanceId);
            if (idx !== -1) taskEntry.activeActors.splice(idx, 1);
          }
          conductor.activeClaudes = Math.max(0, (conductor.activeClaudes || 1) - 1);
          sendStatusUpdate(conductor);

          // Release actor from registry on error too
          releaseActor(taskId, instanceId).catch(e =>
            console.warn(`[TaskRunner] Failed to auto-release failed actor ${instanceId}:`, e.message)
          );

          rejectResult(error);
        }
      });

      // Update conductor's active claude count
      conductor.activeClaudes = (conductor.activeClaudes || 0) + 1;

      // Update task entry's activeActors for status tracking
      if (!taskEntry.activeActors) taskEntry.activeActors = [];
      taskEntry.activeActors.push(instance.instanceId);
      sendStatusUpdate(conductor);

      // Send the instruction to the actor to start work
      const instruction = context.instruction || context.description || taskEntry.description || '';
      if (instruction) {
        sendToActor(taskId, instance.instanceId, instruction);
      }

      return resultPromise;
    },

    /**
     * Release an actor instance.
     */
    releaseActor(instanceId) {
      releaseActor(taskId, instanceId).catch(e =>
        console.warn(`[TaskRunner] Failed to release actor ${instanceId}:`, e.message)
      );

      // Update tracking
      if (taskEntry.activeActors) {
        const idx = taskEntry.activeActors.indexOf(instanceId);
        if (idx !== -1) taskEntry.activeActors.splice(idx, 1);
      }
      conductor.activeClaudes = Math.max(0, (conductor.activeClaudes || 1) - 1);
    },

    /**
     * Send a message to an active actor (for user message forwarding).
     */
    sendMessage(instanceId, message) {
      sendToActor(taskId, instanceId, message);
    }
  };
}

// =====================================================================
// Task Execution Entry Point
// =====================================================================

/**
 * Start task execution via Orchestrator.
 *
 * Called after initTaskDir completes (folder + worktree ready).
 * This is fire-and-forget — the orchestrator runs asynchronously.
 *
 * @param {object} conductor — Conductor singleton instance
 * @param {object} taskEntry — Task registry entry from conductor.tasks Map
 */
export async function startTaskExecution(conductor, taskEntry) {
  const { taskId, title, workDir, scenario, description } = taskEntry;

  console.log(`[TaskRunner] Starting execution for task ${taskId}: "${title}" [${scenario}]`);

  // Update task status
  taskEntry.status = 'running';
  taskEntry.lastUpdate = Date.now();

  // Create actorManager adapter
  const actorManager = createActorManagerAdapter(conductor, taskEntry);

  // Create Orchestrator instance
  const orchestrator = createOrchestrator({
    actorManager,

    onStatusChange: (serializedTask) => {
      // Sync orchestrator state back to conductor's task entry
      taskEntry.status = serializedTask.phase;
      taskEntry.currentStep = `${serializedTask.phase}${serializedTask.currentStepIndex >= 0 ? ' step ' + serializedTask.currentStepIndex : ''}`;
      taskEntry.activeActors = serializedTask.activeActors.map(a => a.instanceId);
      taskEntry.lastUpdate = Date.now();

      // Persist to state.json (async, non-blocking)
      updateTaskInState(taskId, taskEntry).catch(e =>
        console.warn(`[TaskRunner] Failed to persist task ${taskId}:`, e.message)
      );

      // Push status to frontend
      sendConductorMessage({
        type: 'conductor_task_status',
        taskId,
        task: {
          ...taskEntry,
          phase: serializedTask.phase,
          complexity: serializedTask.complexity,
          plan: serializedTask.plan,
          activeActors: serializedTask.activeActors,
          completedActors: serializedTask.completedActors,
          iterations: serializedTask.iterations
        }
      });
      sendStatusUpdate(conductor);
    },

    onLog: (...args) => {
      console.log('[TaskRunner/Orchestrator]', ...args);
    }
  });

  // Register orchestrator
  orchestrators.set(taskId, orchestrator);

  // Start the task (async — orchestrator runs its state machine internally)
  try {
    await orchestrator.startTask({
      taskId,
      title,
      description: description || title,
      scenario,
      workDir
    });

    console.log(`[TaskRunner] Orchestrator started for task ${taskId}`);
  } catch (err) {
    console.error(`[TaskRunner] Failed to start orchestrator for task ${taskId}:`, err.message);

    taskEntry.status = 'failed';
    taskEntry.error = err.message;
    taskEntry.lastUpdate = Date.now();

    await updateTaskInState(taskId, taskEntry).catch(() => {});

    sendConductorOutput(conductor, 'system', {
      message: { role: 'assistant', content: `Task "${title}" failed to start: ${err.message}` }
    });
    sendStatusUpdate(conductor);

    // Cleanup
    orchestrators.delete(taskId);
    await releaseAllActors(taskId, { force: true }).catch(() => {});
  }
}

/**
 * Forward a user message to a running task's orchestrator.
 *
 * @param {string} taskId
 * @param {string} message
 */
export async function forwardToTask(taskId, message) {
  const orchestrator = orchestrators.get(taskId);
  if (!orchestrator) {
    console.warn(`[TaskRunner] Cannot forward to task ${taskId}: no active orchestrator`);
    return;
  }

  await orchestrator.handleUserMessage(taskId, message);
}

/**
 * Stop a running task's orchestrator and release all its actors.
 *
 * @param {string} taskId
 */
export async function stopTaskExecution(taskId) {
  const orchestrator = orchestrators.get(taskId);
  if (!orchestrator) return;

  console.log(`[TaskRunner] Stopping task ${taskId}`);

  // Abort the orchestrator state machine (stops at next phase boundary)
  orchestrator.abort();
  orchestrators.delete(taskId);

  // Release all actors for this task
  await releaseAllActors(taskId, { force: true }).catch(e =>
    console.warn(`[TaskRunner] Error releasing actors for ${taskId}:`, e.message)
  );
}

/**
 * Stop all running task orchestrators (used during conductor shutdown).
 */
export async function stopAllTaskExecutions() {
  const taskIds = [...orchestrators.keys()];
  for (const taskId of taskIds) {
    await stopTaskExecution(taskId);
  }
}
