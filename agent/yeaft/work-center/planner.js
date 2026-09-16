import { resolveWorkItemModel, selectWorkItemVp } from './assignment.js';
import { normalizeWorkCenterSettings, resolveWorkflowSnapshot } from './workflow.js';

function publicVp(vp) {
  return vp ? {
    id: vp.id,
    name: vp.name || vp.id,
    nameZh: vp.nameZh || '',
    description: vp.description || vp.role || '',
    descriptionZh: vp.descriptionZh || vp.roleZh || vp.description || vp.role || '',
    role: vp.role || '',
    roleZh: vp.roleZh || '',
    area: vp.area || '',
    traits: Array.isArray(vp.traits) ? vp.traits : [],
    modelHint: vp.modelHint || null,
  } : null;
}

export function previewWorkCenterPlan({ settings, workflowId, stageOverrides, registry, config }) {
  const normalizedSettings = normalizeWorkCenterSettings(settings);
  const workflow = resolveWorkflowSnapshot(settings, workflowId, stageOverrides);
  const vps = registry.listVps();
  const syntheticRuns = [];
  const stages = workflow.stages.map(stage => {
    try {
      const assignment = selectWorkItemVp({
        policy: stage.assignmentPolicy,
        stageType: stage.type,
        vps,
        priorRuns: syntheticRuns,
      });
      const model = resolveWorkItemModel(
        config,
        assignment.vp,
        stage.modelPolicy,
        normalizedSettings.modelTags,
      );
      syntheticRuns.push({
        actionType: stage.type,
        roleSnapshot: { actionType: stage.type },
        vpSnapshot: { id: assignment.vp.id },
      });
      return {
        id: stage.id,
        name: stage.name,
        type: stage.type,
        assignmentPolicy: stage.assignmentPolicy,
        modelPolicy: stage.modelPolicy,
        selectedVp: publicVp(assignment.vp),
        selectionReason: assignment.reason,
        model: {
          id: model.model,
          provider: model.provider,
          effort: model.effort,
          source: model.source,
        },
        error: null,
      };
    } catch (error) {
      return {
        id: stage.id,
        name: stage.name,
        type: stage.type,
        assignmentPolicy: stage.assignmentPolicy,
        modelPolicy: stage.modelPolicy,
        selectedVp: null,
        selectionReason: null,
        model: null,
        error: error?.message || String(error),
      };
    }
  });
  return { workflow, stages, valid: stages.every(stage => !stage.error) };
}
