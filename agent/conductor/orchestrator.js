/**
 * Conductor Orchestrator — JS 状态机核心
 *
 * 不是 Claude 实例。是纯 JS 状态机。
 * 每个 Task 一个 Orchestrator 实例，驱动 TRIAGE → EXECUTION → ACCEPTANCE 全流程。
 *
 * 核心职责：
 * 1. 状态流转 — Phase 之间的转换
 * 2. TRIAGE 决策 — TRIVIAL / SMALL / COMPLEX
 * 3. Actor 调度 — 通过 actorManager.createActor() 创建/释放
 * 4. Quality Gate — review pass/fail → 重试 / 升级 discussion
 * 5. 迭代控制 — maxIterations = 3
 *
 * 接口约定：
 *   actorManager.createActor(persona, specialty, taskContext) → Promise<ActorResult>
 *   actorManager.releaseActor(instanceId) → void
 *   statusCallback(task) → void — 状态变更通知
 */

import {
  Phase, Complexity,
  createTask, createActorInstance, createExecutionPlan,
  transitionPhase, addActiveActor, completeActor, failActor,
  recordStepFail, getStepFailCount, serializeTask
} from './task.js';

import {
  getFlow, getThinkingMode,
  getDiscussionActors, getPlanningActors, getPlanningLead,
  getQualityGateConfig, getAcceptanceVerifier,
  needsQualityGate, getPostPlanningDiscussion, getExecutionStages,
  isQualityGateBeforeExecution
} from './orchestrator-flows.js';

// =====================================================================
// Orchestrator Class
// =====================================================================

export class Orchestrator {
  /**
   * @param {object} params
   * @param {object} params.actorManager  — { createActor, releaseActor }
   * @param {Function} params.onStatusChange — 状态变更回调
   * @param {Function} [params.onLog]      — 日志回调
   */
  constructor({ actorManager, onStatusChange, onLog }) {
    if (!actorManager?.createActor) {
      throw new Error('actorManager.createActor is required');
    }
    this.actorManager = actorManager;
    this.onStatusChange = onStatusChange || (() => {});
    this.log = onLog || ((...args) => console.log('[Orchestrator]', ...args));

    /** @type {Map<string, Task>} */
    this.tasks = new Map();
  }

  // ===================================================================
  // Public API
  // ===================================================================

  /**
   * 创建并启动新 Task
   *
   * @param {object} params
   * @param {string} params.title
   * @param {string} params.description
   * @param {string} params.scenario — 'dev' | 'writing' | 'trading' | 'video'
   * @param {string} params.workDir
   * @returns {Task}
   */
  async startTask({ title, description, scenario, workDir }) {
    const flow = getFlow(scenario);  // 验证 scenario 合法性
    const task = createTask({ title, description, scenario, workDir });
    this.tasks.set(task.taskId, task);
    this._notify(task);

    this.log(`Task created: ${task.taskId} "${title}" [${scenario}]`);

    // 异步启动状态机，不阻塞调用者
    this._runStateMachine(task, flow).catch(err => {
      this.log(`Task ${task.taskId} state machine error:`, err);
      task.error = err.message || String(err);
      if (task.phase !== Phase.DONE && task.phase !== Phase.FAILED) {
        transitionPhase(task, Phase.FAILED);
      }
      this._notify(task);
    });

    return task;
  }

  /**
   * 获取 Task 状态
   */
  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /**
   * 获取所有 Task
   */
  getAllTasks() {
    return [...this.tasks.values()];
  }

  /**
   * 获取 Task 序列化数据（用于前端推送）
   */
  getTaskStatus(taskId) {
    const task = this.tasks.get(taskId);
    return task ? serializeTask(task) : null;
  }

  /**
   * 用户消息注入（Task 对话页直接交互时）
   * TODO: 后续实现用户消息处理
   */
  async handleUserMessage(taskId, message) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.log(`User message for ${taskId}: ${message.substring(0, 100)}...`);
    // 用户消息处理逻辑由 Conductor 引擎层实现
  }

  // ===================================================================
  // State Machine — 主循环
  // ===================================================================

  /**
   * 状态机主循环：Phase 之间的驱动
   */
  async _runStateMachine(task, flow) {
    while (task.phase !== Phase.DONE && task.phase !== Phase.FAILED) {
      this.log(`Task ${task.taskId} entering phase: ${task.phase}`);

      switch (task.phase) {
        case Phase.TRIAGE:
          await this._phaseTriage(task, flow);
          break;
        case Phase.DISCUSSION:
          await this._phaseDiscussion(task, flow);
          break;
        case Phase.PLANNING:
          await this._phasePlanning(task, flow);
          break;
        case Phase.EXECUTION:
          await this._phaseExecution(task, flow);
          break;
        case Phase.QUALITY_GATE:
          await this._phaseQualityGate(task, flow);
          break;
        case Phase.ACCEPTANCE:
          await this._phaseAcceptance(task, flow);
          break;
        default:
          throw new Error(`Unhandled phase: ${task.phase}`);
      }
    }

    this.log(`Task ${task.taskId} finished: ${task.phase}`);
  }

  // ===================================================================
  // Phase: TRIAGE
  // ===================================================================

  async _phaseTriage(task, flow) {
    this.log(`TRIAGE: analyzing task "${task.title}"`);

    // 使用 actorManager 创建一个 triage actor
    // triage 本质上可以是一次简单的 LLM 判定
    const triageResult = await this._runTriageActor(task, flow);
    const complexity = triageResult?.complexity || Complexity.SMALL;

    task.complexity = complexity;
    this.log(`TRIAGE result: ${complexity}`);

    switch (complexity) {
      case Complexity.TRIVIAL:
        // 跳过 discussion + planning, 直接 execution
        transitionPhase(task, Phase.EXECUTION);
        break;
      case Complexity.SMALL:
        // 跳过 discussion, 直接 planning
        transitionPhase(task, Phase.PLANNING);
        break;
      case Complexity.COMPLEX:
        // 进入 discussion
        transitionPhase(task, Phase.DISCUSSION);
        break;
      default:
        transitionPhase(task, Phase.PLANNING);
    }
    this._notify(task);
  }

  /**
   * 运行 TRIAGE actor — 分析任务复杂度
   */
  async _runTriageActor(task, flow) {
    const triageContext = {
      taskId: task.taskId,
      description: task.description,
      scenario: task.scenario,
      triageRules: flow.triageRules,
      workDir: task.workDir,
      instruction: `Analyze the following task and determine its complexity level.
Rules:
- TRIVIAL: ${flow.triageRules.trivial.join('; ')}
- SMALL: ${flow.triageRules.small.join('; ')}
- COMPLEX: ${flow.triageRules.complex.join('; ')}

Task: "${task.description}"

Respond with JSON: { "complexity": "trivial"|"small"|"complex", "reasoning": "..." }`
    };

    try {
      const result = await this.actorManager.createActor(
        { id: '_triage', name: 'Triage' },
        'planning',
        triageContext
      );
      return this._parseTriageResult(result);
    } catch (err) {
      this.log(`TRIAGE actor failed: ${err.message}, defaulting to SMALL`);
      return { complexity: Complexity.SMALL };
    }
  }

  /**
   * 解析 TRIAGE actor 返回值
   */
  _parseTriageResult(result) {
    if (!result) return { complexity: Complexity.SMALL };

    // result 可能是 { complexity: '...' } 或包含 text 的结构
    if (result.complexity && Object.values(Complexity).includes(result.complexity)) {
      return result;
    }

    // 尝试从文本结果中提取
    const text = typeof result === 'string' ? result : (result.text || result.content || '');
    const lower = text.toLowerCase();

    if (lower.includes('trivial')) return { complexity: Complexity.TRIVIAL };
    if (lower.includes('complex')) return { complexity: Complexity.COMPLEX };
    return { complexity: Complexity.SMALL };
  }

  // ===================================================================
  // Phase: DISCUSSION
  // ===================================================================

  async _phaseDiscussion(task, flow) {
    // 区分两种 discussion:
    // 1. 初始 discussion (task.plan === null) — 标准发散讨论
    // 2. Post-planning discussion (task.plan !== null) — Trading 对抗性审查
    const isPostPlanning = task.plan !== null;

    if (isPostPlanning) {
      const ppConfig = getPostPlanningDiscussion(flow);
      if (ppConfig) {
        this.log(`DISCUSSION (post-planning): ${ppConfig.purpose}`);
        await this._runActorsParallel(task, ppConfig.actors, {
          instruction: `${ppConfig.purpose}\n\nChallenge points:\n${ppConfig.challengePoints.map(p => `- ${p}`).join('\n')}\n\nStrategy to review: ${JSON.stringify(task.plan)}`,
          memoryPath: this._getMemoryPath(task)
        });
        this.log(`DISCUSSION (post-planning): completed`);
      }

      // Post-planning discussion 之后:
      // Trading: QG before execution → QUALITY_GATE
      // Others: → EXECUTION
      if (isQualityGateBeforeExecution(flow)) {
        transitionPhase(task, Phase.QUALITY_GATE);
      } else {
        transitionPhase(task, Phase.EXECUTION);
      }
      this._notify(task);
      return;
    }

    // 标准初始 discussion
    this.log(`DISCUSSION: starting for task ${task.taskId}`);

    const context = { uiInvolved: this._isUiInvolved(task) };
    const actorDefs = getDiscussionActors(flow, context);

    if (actorDefs.length === 0) {
      this.log('DISCUSSION: no actors needed, skipping to PLANNING');
      transitionPhase(task, Phase.PLANNING);
      this._notify(task);
      return;
    }

    const results = await this._runActorsParallel(task, actorDefs, {
      instruction: `Discussion topic: ${task.description}`,
      memoryPath: this._getMemoryPath(task)
    });

    this.log(`DISCUSSION: ${results.length} actors completed`);

    transitionPhase(task, Phase.PLANNING);
    this._notify(task);
  }

  // ===================================================================
  // Phase: PLANNING
  // ===================================================================

  async _phasePlanning(task, flow) {
    this.log(`PLANNING: starting for task ${task.taskId}`);

    const plannerDefs = getPlanningActors(flow);
    const lead = getPlanningLead(flow);

    // 创建 planning actors
    const results = await this._runActorsParallel(task, plannerDefs, {
      instruction: `Create an execution plan for: ${task.description}`,
      memoryPath: this._getMemoryPath(task),
      planPath: this._getPlanPath(task)
    });

    // 合并 planning 结果 — Lead 的结果优先
    const plan = this._mergePlanningResults(results, lead);

    if (!plan || !plan.steps || plan.steps.length === 0) {
      this.log('PLANNING: failed to produce a valid plan');
      // 第一次 planning 失败可以重试
      if (task.iterations < task.maxIterations) {
        task.iterations++;
        this.log(`PLANNING: retry (iteration ${task.iterations}/${task.maxIterations})`);
        this._notify(task);
        return; // 重新进入 PLANNING
      }
      task.error = 'Failed to produce execution plan after max iterations';
      transitionPhase(task, Phase.FAILED);
      this._notify(task);
      return;
    }

    task.plan = plan;
    task.currentStepIndex = 0;
    this.log(`PLANNING: produced plan with ${plan.steps.length} steps`);

    // 如果场景有 post-planning discussion（Trading 对抗性审查），transition 到 DISCUSSION
    const ppConfig = getPostPlanningDiscussion(flow);
    if (ppConfig) {
      transitionPhase(task, Phase.DISCUSSION);
    } else if (isQualityGateBeforeExecution(flow)) {
      // QG before execution（不常见，但保持灵活性）
      transitionPhase(task, Phase.QUALITY_GATE);
    } else {
      transitionPhase(task, Phase.EXECUTION);
    }
    this._notify(task);
  }

  /**
   * 合并多个 planner 的结果，以 lead 的结果为主
   */
  _mergePlanningResults(results, leadId) {
    if (!results || results.length === 0) return null;

    // 找到 lead 的结果
    const leadResult = results.find(r => r?.personaId === leadId);
    const base = leadResult || results[0];

    if (!base) return null;

    // 如果 result 已经是 plan 格式
    if (base.plan) return base.plan;

    // 尝试解析文本格式的 plan
    if (base.text || base.content) {
      try {
        const text = base.text || base.content;
        const parsed = JSON.parse(text);
        if (parsed.steps) {
          return createExecutionPlan(parsed);
        }
      } catch {
        // 无法解析，用默认格式
      }
    }

    // 如果 result 直接包含 steps
    if (base.steps) {
      return createExecutionPlan(base);
    }

    return null;
  }

  // ===================================================================
  // Phase: EXECUTION
  // ===================================================================

  async _phaseExecution(task, flow) {
    this.log(`EXECUTION: starting for task ${task.taskId}`);

    // Video 场景：严格串行 stages
    const stages = getExecutionStages(flow);
    if (stages) {
      await this._executeVideoStages(task, flow, stages);
      return;
    }

    // TRIVIAL: 没有 plan，直接创建一个 actor 执行
    if (!task.plan) {
      await this._executeTrivial(task, flow);
      return;
    }

    // 标准执行：按 plan 的步骤执行
    await this._executeByPlan(task, flow);
  }

  /**
   * TRIVIAL 任务执行：直接创建一个收敛 actor
   */
  async _executeTrivial(task, flow) {
    this.log('EXECUTION: trivial task, single actor');

    const coderPersona = flow.execution.primaryCoder
      || flow.execution.primaryWriter
      || flow.execution.executor;

    const specialty = flow.execution.executorSpecialty || 'coding';

    const result = await this._runSingleActor(task, {
      personaId: coderPersona,
      specialty
    }, {
      instruction: task.description,
      workDir: task.workDir
    });

    // Trivial 完成后检查是否需要 quality gate
    if (needsQualityGate(flow, specialty)) {
      transitionPhase(task, Phase.QUALITY_GATE);
    } else {
      transitionPhase(task, Phase.ACCEPTANCE);
    }
    this._notify(task);
  }

  /**
   * 按 Plan 步骤执行
   */
  async _executeByPlan(task, flow) {
    const steps = task.plan.steps;

    while (task.currentStepIndex < steps.length) {
      const step = steps[task.currentStepIndex];

      if (step.status === 'completed') {
        task.currentStepIndex++;
        continue;
      }

      // 收集可并行的步骤
      const parallelSteps = this._collectParallelSteps(steps, task.currentStepIndex);

      this.log(`EXECUTION: executing step(s) ${parallelSteps.map(s => s.index).join(', ')}`);

      // 并行执行
      const actorDefs = parallelSteps.map(s => ({
        personaId: s.assignedPersona,
        specialty: s.specialty
      }));

      const results = await this._runActorsParallel(task, actorDefs, {
        instruction: parallelSteps.map(s => `Step ${s.index}: ${s.title}\n${s.description}`).join('\n\n'),
        workDir: task.workDir
      });

      // 标记步骤完成
      for (let i = 0; i < parallelSteps.length; i++) {
        const s = parallelSteps[i];
        const r = results[i];
        s.status = r?.error ? 'failed' : 'completed';
        s.result = r;
      }

      // 每组并行步骤完成后，检查是否需要 quality gate
      const executedSpecialties = parallelSteps.map(s => s.specialty);
      const anyNeedsQG = executedSpecialties.some(sp => needsQualityGate(flow, sp));

      if (anyNeedsQG) {
        transitionPhase(task, Phase.QUALITY_GATE);
        this._notify(task);
        return; // 交给 quality gate phase 处理
      }

      // 前进到并行组之后的下一个 pending 步骤
      task.currentStepIndex = this._advancePastCompletedSteps(task);
      this._notify(task);
    }

    // 所有步骤执行完毕
    this.log('EXECUTION: all steps completed');
    transitionPhase(task, Phase.ACCEPTANCE);
    this._notify(task);
  }

  /**
   * 收集从 startIndex 开始的可并行步骤
   */
  _collectParallelSteps(steps, startIndex) {
    const start = steps[startIndex];
    if (!start) return [];

    const result = [start];

    // 如果当前步骤标记为可并行，继续收集同组的
    if (start.parallel && start.parallelGroup) {
      for (let i = startIndex + 1; i < steps.length; i++) {
        const s = steps[i];
        if (s.parallel && s.parallelGroup === start.parallelGroup && s.status === 'pending') {
          // 检查依赖是否满足
          const depsMet = s.dependencies.every(dep => steps[dep]?.status === 'completed');
          if (depsMet) result.push(s);
        } else {
          break;
        }
      }
    }

    return result;
  }

  /**
   * Video 场景：严格串行执行 stages
   */
  async _executeVideoStages(task, flow, stages) {
    this.log('EXECUTION: video strict serial stages');

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      this.log(`EXECUTION: video stage ${i + 1}/${stages.length}: ${stage.name}`);

      // 执行 stage actor
      const result = await this._runSingleActor(task, stage.actor, {
        instruction: stage.description,
        workDir: task.workDir,
        memoryPath: this._getMemoryPath(task)
      });

      // Stage 内置 review（如果配置了）
      if (stage.reviewAfter) {
        this.log(`EXECUTION: video stage ${stage.name} review`);
        const reviewResult = await this._runSingleActor(task, stage.reviewAfter, {
          instruction: `Review the ${stage.name} output for quality and consistency`,
          workDir: task.workDir,
          memoryPath: this._getMemoryPath(task)
        });

        // 如果 review 不通过，重做该 stage
        if (reviewResult && this._isReviewFail(reviewResult)) {
          this.log(`EXECUTION: video stage ${stage.name} review FAILED, retrying stage`);
          const failCount = recordStepFail(task, i);
          if (failCount >= 2) {
            this.log(`EXECUTION: video stage ${stage.name} failed ${failCount} times, escalating`);
            task.error = `Video stage "${stage.name}" failed review ${failCount} times`;
            transitionPhase(task, Phase.FAILED);
            this._notify(task);
            return;
          }
          i--; // 重做当前 stage
          continue;
        }
      }
    }

    // 所有 stages 完成，进入 quality gate
    transitionPhase(task, Phase.QUALITY_GATE);
    this._notify(task);
  }

  // ===================================================================
  // Phase: QUALITY GATE
  // ===================================================================

  async _phaseQualityGate(task, flow) {
    this.log(`QUALITY GATE: starting for task ${task.taskId}`);

    const qgConfig = getQualityGateConfig(flow);
    const qgInstruction = `Review the execution output for quality, correctness, and standards compliance.
Pass threshold: ${qgConfig.passThreshold || 'N/A'}
Check areas: ${qgConfig.checkAreas?.join(', ') || 'all'}`;
    const qgContext = {
      workDir: task.workDir,
      memoryPath: this._getMemoryPath(task)
    };

    let results;

    // 如果配置了并行且同时有 reviewer + tester，并行运行
    if (qgConfig.parallel && qgConfig.reviewer && qgConfig.tester) {
      const actorDefs = [qgConfig.reviewer, qgConfig.tester];
      const parallelResults = await this._runActorsParallel(task, actorDefs, {
        ...qgContext,
        instruction: qgInstruction
      });
      results = [
        { type: 'review', result: parallelResults[0] },
        { type: 'testing', result: parallelResults[1] }
      ];
    } else {
      // 串行
      results = [];
      if (qgConfig.reviewer) {
        const reviewResult = await this._runSingleActor(task, qgConfig.reviewer, {
          ...qgContext,
          instruction: qgInstruction
        });
        results.push({ type: 'review', result: reviewResult });
      }
      if (qgConfig.tester) {
        const testResult = await this._runSingleActor(task, qgConfig.tester, {
          ...qgContext,
          instruction: 'Test the implementation. Cover core logic and edge cases.'
        });
        results.push({ type: 'testing', result: testResult });
      }
    }

    // 判定结果
    const allPass = results.every(r => !this._isReviewFail(r.result));

    if (allPass) {
      this.log('QUALITY GATE: PASS');

      // Trading: QG before execution → pass → EXECUTION
      if (isQualityGateBeforeExecution(flow)) {
        transitionPhase(task, Phase.EXECUTION);
      } else if (task.plan && task.currentStepIndex < task.plan.steps.length - 1) {
        // 还有后续步骤，回到 execution 继续
        task.currentStepIndex = this._advancePastCompletedSteps(task);
        transitionPhase(task, Phase.EXECUTION);
      } else {
        transitionPhase(task, Phase.ACCEPTANCE);
      }
    } else {
      this.log('QUALITY GATE: FAIL');

      const stepIdx = task.currentStepIndex;
      const failCount = recordStepFail(task, stepIdx);
      const maxRetries = qgConfig.maxRetries || 3;

      if (failCount >= maxRetries) {
        // 升级：创建 discussion 重新讨论方案
        this.log(`QUALITY GATE: step ${stepIdx} failed ${failCount} times, escalating to DISCUSSION`);
        // 重置 plan 以触发完整的 re-plan 流程（而非误入 post-planning discussion 路径）
        task.plan = null;
        task.currentStepIndex = -1;
        transitionPhase(task, Phase.DISCUSSION);
      } else {
        // 打回修改：回到 execution 重做当前步骤
        this.log(`QUALITY GATE: step ${stepIdx} fail #${failCount}, retrying execution`);
        if (task.plan?.steps[stepIdx]) {
          task.plan.steps[stepIdx].status = 'pending';
        }
        transitionPhase(task, Phase.EXECUTION);
      }
    }

    this._notify(task);
  }

  /**
   * 判断 review/test 结果是否为 fail
   */
  _isReviewFail(result) {
    if (!result) return true;
    if (result.error) return true;

    // 检查 pass/fail 标记
    if (result.pass === false) return true;
    if (result.pass === true) return false;

    // 检查评分
    if (typeof result.score === 'number') {
      return result.score < 9;
    }

    // 从文本中推断
    const text = (result.text || result.content || '').toLowerCase();
    if (text.includes('fail') || text.includes('reject')) return true;
    if (text.includes('pass') || text.includes('approve')) return false;

    // 默认通过（宁可多跑一轮也不卡住）
    return false;
  }

  // ===================================================================
  // Phase: ACCEPTANCE
  // ===================================================================

  async _phaseAcceptance(task, flow) {
    this.log(`ACCEPTANCE: starting for task ${task.taskId}`);

    const verifier = getAcceptanceVerifier(flow);

    const result = await this._runSingleActor(task, verifier, {
      instruction: `Acceptance verification for task "${task.title}".
Verify all success criteria are met:
${task.plan?.successCriteria?.map((c, i) => `${i + 1}. ${c}`).join('\n') || 'N/A'}

Focus areas: ${flow.acceptance.focusAreas.join(', ')}`,
      workDir: task.workDir,
      memoryPath: this._getMemoryPath(task)
    });

    const accepted = result && !this._isReviewFail(result);

    if (accepted) {
      this.log('ACCEPTANCE: PASSED');
      task.summary = result?.summary || result?.text || 'Task completed successfully';
      transitionPhase(task, Phase.DONE);
    } else {
      this.log('ACCEPTANCE: REJECTED');
      task.iterations++;

      if (task.iterations >= task.maxIterations) {
        this.log(`ACCEPTANCE: exceeded max iterations (${task.maxIterations}), marking FAILED`);
        task.error = `Failed acceptance after ${task.maxIterations} iterations`;
        transitionPhase(task, Phase.FAILED);
      } else {
        this.log(`ACCEPTANCE: iteration ${task.iterations}/${task.maxIterations}, returning to planning`);
        // 回到合适的 Phase
        // 如果是 plan 问题 → PLANNING; 如果是执行问题 → EXECUTION
        const target = this._determineRetryTarget(result);
        transitionPhase(task, target);
      }
    }

    this._notify(task);
  }

  /**
   * 根据 acceptance 结果决定回退到哪个 phase
   */
  _determineRetryTarget(result) {
    if (!result) return Phase.PLANNING;

    const text = (result.text || result.content || '').toLowerCase();
    if (text.includes('plan') || text.includes('architecture') || text.includes('design')) {
      return Phase.PLANNING;
    }
    return Phase.EXECUTION;
  }

  // ===================================================================
  // Actor 调度 Helpers
  // ===================================================================

  /**
   * 运行单个 Actor，等待完成
   */
  async _runSingleActor(task, actorDef, context) {
    const thinkingMode = getThinkingMode(actorDef.specialty);
    const actor = createActorInstance({
      personaId: actorDef.personaId,
      personaName: actorDef.personaName || actorDef.personaId,
      specialty: actorDef.specialty,
      thinkingMode,
      taskId: task.taskId,
      threadId: context.threadId,
      worktreePath: context.workDir,
      activity: `${actorDef.specialty} for "${task.title}"`
    });

    addActiveActor(task, actor);
    this._notify(task);

    try {
      const result = await this.actorManager.createActor(
        { id: actorDef.personaId, name: actor.personaName },
        actorDef.specialty,
        { ...context, taskId: task.taskId, actorInstanceId: actor.instanceId }
      );

      completeActor(task, actor.instanceId, result);
      this._notify(task);
      return result;
    } catch (err) {
      this.log(`Actor ${actor.instanceId} failed: ${err.message}`);
      failActor(task, actor.instanceId, err);
      this._notify(task);
      return { error: err.message };
    }
  }

  /**
   * 并行运行多个 Actor
   *
   * @returns {Array<ActorResult>}
   */
  async _runActorsParallel(task, actorDefs, context) {
    if (actorDefs.length === 0) return [];

    const promises = actorDefs.map(def =>
      this._runSingleActor(task, def, context)
    );

    const results = await Promise.allSettled(promises);

    return results.map((r, i) => {
      if (r.status === 'fulfilled') {
        // 不修改原始 result 对象，创建新对象附加 personaId
        return { ...r.value, personaId: actorDefs[i].personaId };
      }
      return { error: r.reason?.message || 'Unknown error', personaId: actorDefs[i].personaId };
    });
  }

  // ===================================================================
  // Utility
  // ===================================================================

  /**
   * 跳过已完成的步骤，返回下一个 pending 步骤的 index
   * 修复 #2: 并行步骤组完成后正确推进到下一个未完成的步骤
   */
  _advancePastCompletedSteps(task) {
    if (!task.plan) return task.currentStepIndex;
    const steps = task.plan.steps;
    let idx = task.currentStepIndex;
    while (idx < steps.length && steps[idx].status === 'completed') {
      idx++;
    }
    return idx;
  }

  /**
   * 判断任务是否涉及 UI
   */
  _isUiInvolved(task) {
    const desc = (task.description || '').toLowerCase();
    return /\b(ui|前端|frontend|界面|页面|组件|component|css|style|布局|layout|设计|design|按钮|button|表单|form)\b/i.test(desc);
  }

  /**
   * 获取 task 的 memory.md 路径（约定）
   */
  _getMemoryPath(task) {
    return `.conductor/tasks/${task.taskId}/memory.md`;
  }

  /**
   * 获取 task 的 plan.json 路径（约定）
   */
  _getPlanPath(task) {
    return `.conductor/tasks/${task.taskId}/plan.json`;
  }

  /**
   * 通知状态变更
   */
  _notify(task) {
    try {
      this.onStatusChange(serializeTask(task));
    } catch (err) {
      this.log(`Status callback error: ${err.message}`);
    }
  }
}

// =====================================================================
// Factory Function
// =====================================================================

/**
 * 创建 Orchestrator 实例
 *
 * @param {object} params
 * @param {object} params.actorManager — { createActor(persona, specialty, ctx) → Promise<Result> }
 * @param {Function} [params.onStatusChange]
 * @param {Function} [params.onLog]
 * @returns {Orchestrator}
 */
export function createOrchestrator({ actorManager, onStatusChange, onLog }) {
  return new Orchestrator({ actorManager, onStatusChange, onLog });
}
