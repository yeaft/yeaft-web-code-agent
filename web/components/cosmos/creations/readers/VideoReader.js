/**
 * Yeaft Cosmos Creations — VideoReader (video_episode modality)
 *
 * Parses structured storyboard/video JSON with graceful fallback.
 * Uses exact CSS classes from web/styles/cosmos/creations.css and i18n keys from web/i18n/creations.js.
 */
import { useCreationsStore } from '../../../../stores/creations.js';

const PLAYABLE_VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const PLAYABLE_VIDEO_EXT = /\.(mp4|webm|mov)$/i;

function isPlayableVideoSource(src) {
  if (!src || !src.id) return false;
  if (src.playableVideo === true) return true;
  if (src.playableVideo === false) return false;
  // Legacy records without a verified playableVideo flag fall back to declared MIME / extension.
  const mime = String(src.detectedMimeType || src.mimeType || '').toLowerCase().trim();
  const name = String(src.name || src.filename || '').toLowerCase().trim();
  return PLAYABLE_VIDEO_MIMES.has(mime) || PLAYABLE_VIDEO_EXT.test(name);
}

function makeSceneId() {
  return `scene_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeScene(raw, idx) {
  const dur = Number(raw?.durationSec);
  return {
    sceneId: raw?.sceneId || raw?.id || makeSceneId(),
    title: typeof raw?.title === 'string' ? raw.title : `Scene ${idx + 1}`,
    durationSec: Number.isFinite(dur) && dur > 0 ? dur : 6,
    visualPrompt: typeof raw?.visualPrompt === 'string' ? raw.visualPrompt : '',
    assetId: raw?.assetId || '',
    sourceId: raw?.sourceId || '',
    narration: typeof raw?.narration === 'string' ? raw.narration : '',
    caption: typeof raw?.caption === 'string' ? raw.caption : '',
    shotType: typeof raw?.shotType === 'string' ? raw.shotType : 'medium',
  };
}

function parseVideoContent(content, fallbackTitle) {
  const raw = String(content || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && (Array.isArray(parsed.scenes) || parsed.videoAssetId || parsed.videoSourceId)) {
        return {
          videoAssetId: parsed.videoAssetId || '',
          videoSourceId: parsed.videoSourceId || '',
          scenes: Array.isArray(parsed.scenes) ? parsed.scenes.map((s, i) => normalizeScene(s, i)) : [],
        };
      }
    } catch {
      return {
        videoAssetId: '',
        videoSourceId: '',
        scenes: [
          normalizeScene({
            title: fallbackTitle || 'Scene 1',
            narration: raw,
            caption: raw.slice(0, 80),
          }, 0),
        ],
      };
    }
  }
  return {
    videoAssetId: '',
    videoSourceId: '',
    scenes: [],
  };
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export default {
  name: 'VideoReader',
  setup() {
    const creationsStore = useCreationsStore();
    return { creationsStore };
  },
  props: {
    node: { type: Object, required: true },
    content: { type: String, default: '' },
    contentLoaded: { type: Boolean, default: true },
    loadedRevId: { type: String, default: null },
    mode: { type: String, default: 'read' },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
    sources: { type: Array, default: () => [] },
    saving: { type: Boolean, default: false },
    onSaveContent: { type: Function, default: null },
  },
  emits: ['save-content', 'request-ai-edit', 'finalize-node'],
  data() {
    return {
      episode: parseVideoContent(this.content, this.node?.title),
      currentTime: 0,
      nativeDuration: 0,
      playing: false,
      playbackError: false,
      editing: false,
      dirty: false,
      editBaseRevId: this.contentLoaded ? this.loadedRevId : (this.loadedRevId ?? this.node?.currentRevId ?? null),
      conflictError: '',
      saveError: '',
      _playTimer: null,
    };
  },
  computed: {
    scenes() {
      return this.episode.scenes || [];
    },
    videoSources() {
      return (this.sources || []).filter((s) => isPlayableVideoSource(s));
    },
    videoUrl() {
      if (this.episode.videoAssetId) {
        return this.creationsStore.mediaUrl(this.agentId, this.creationId, 'asset', this.episode.videoAssetId);
      }
      if (this.episode.videoSourceId) {
        return this.creationsStore.mediaUrl(this.agentId, this.creationId, 'source', this.episode.videoSourceId);
      }
      return '';
    },
    sceneTimeline() {
      let acc = 0;
      return this.scenes.map((scene, idx) => {
        const start = acc;
        const dur = Math.max(1, Number(scene.durationSec) || 6);
        acc += dur;
        return { scene, idx, start, end: acc, duration: dur };
      });
    },
    totalDuration() {
      if (this.videoUrl && this.nativeDuration > 0) return this.nativeDuration;
      if (!this.sceneTimeline.length) return 0;
      return this.sceneTimeline[this.sceneTimeline.length - 1].end;
    },
    activeSceneEntry() {
      if (!this.sceneTimeline.length) return null;
      const t = this.currentTime;
      return (
        this.sceneTimeline.find((e) => t >= e.start && t < e.end) ||
        this.sceneTimeline[this.sceneTimeline.length - 1]
      );
    },
    activeScene() {
      return this.activeSceneEntry?.scene || null;
    },
    activeSceneVisualUrl() {
      const s = this.activeScene;
      if (!s) return '';
      if (s.assetId) {
        return this.creationsStore.mediaUrl(this.agentId, this.creationId, 'asset', s.assetId);
      }
      if (s.sourceId) {
        return this.creationsStore.mediaUrl(this.agentId, this.creationId, 'source', s.sourceId);
      }
      return '';
    },
    formattedCurrentTime() {
      return formatTime(this.currentTime);
    },
    formattedTotalDuration() {
      return formatTime(this.totalDuration);
    },
  },
  watch: {
    content(newVal) {
      if (!this.dirty) {
        this.episode = parseVideoContent(newVal, this.node?.title);
        this.editBaseRevId = this.contentLoaded ? this.loadedRevId : (this.loadedRevId ?? this.node?.currentRevId ?? null);
      }
    },
    videoUrl() {
      this.playbackError = false;
    },
    'node.id'(newId, oldId) {
      if (oldId) this.syncStoreDirty(false, oldId);
      this.stopStoryboardPlayback();
      this.episode = parseVideoContent(this.content, this.node?.title);
      this.currentTime = 0;
      this.nativeDuration = 0;
      this.playbackError = false;
      this.dirty = false;
      this.editing = false;
      this.editBaseRevId = this.contentLoaded ? this.loadedRevId : (this.loadedRevId ?? this.node?.currentRevId ?? null);
      this.conflictError = '';
      this.saveError = '';
    },
  },
  beforeUnmount() {
    this.syncStoreDirty(false);
    this.stopStoryboardPlayback();
  },
  methods: {
    formatTime,
    syncStoreDirty(isDirty, nodeId = this.node?.id) {
      if (this.agentId && this.creationId && nodeId) {
        this.creationsStore.setNodeDirty(this.agentId, this.creationId, nodeId, isDirty);
      }
    },
    toggleEditing() {
      if (!this.editing) {
        if (!this.contentLoaded) return;
        if (!this.dirty) {
          this.editBaseRevId = this.loadedRevId;
          this.conflictError = '';
          this.saveError = '';
        }
        this.editing = true;
        this.syncStoreDirty(this.dirty);
        return;
      }
      this.editing = false;
      if (!this.dirty) {
        this.syncStoreDirty(false);
      }
    },
    markDirty() {
      if (!this.contentLoaded && !this.editing) return;
      if (!this.dirty) {
        this.editBaseRevId = this.loadedRevId;
      }
      this.dirty = true;
      this.syncStoreDirty(true);
    },
    onVideoLoadedMetadata(e) {
      this.playbackError = false;
      const dur = Number(e.target?.duration);
      if (Number.isFinite(dur) && dur > 0) {
        this.nativeDuration = dur;
      }
    },
    onVideoError() {
      this.playbackError = true;
    },
    onVideoTimeUpdate(e) {
      this.currentTime = Number(e.target?.currentTime) || 0;
    },
    onSelectVideoSource(e) {
      const nextSourceId = String(e.target?.value || '');
      this.markDirty();
      this.episode = {
        ...this.episode,
        videoSourceId: nextSourceId,
        videoAssetId: nextSourceId ? '' : this.episode.videoAssetId,
      };
      this.nativeDuration = 0;
    },
    toggleStoryboardPlay() {
      if (this.videoUrl) {
        const video = this.$refs.videoEl;
        if (!video) return;
        if (video.paused) video.play?.().catch(() => {});
        else video.pause?.();
        return;
      }
      if (this.playing) {
        this.stopStoryboardPlayback();
      } else {
        if (this.totalDuration <= 0) return;
        if (this.currentTime >= this.totalDuration) this.currentTime = 0;
        this.playing = true;
        this._playTimer = setInterval(() => {
          const next = this.currentTime + 0.1;
          if (next >= this.totalDuration) {
            this.currentTime = this.totalDuration;
            this.stopStoryboardPlayback();
          } else {
            this.currentTime = next;
          }
        }, 100);
      }
    },
    stopStoryboardPlayback() {
      this.playing = false;
      if (this._playTimer) {
        clearInterval(this._playTimer);
        this._playTimer = null;
      }
    },
    seekTo(sec) {
      const maxDur = this.videoUrl && this.nativeDuration > 0 ? this.nativeDuration : (this.totalDuration || 0);
      const clamped = maxDur > 0 ? Math.max(0, Math.min(maxDur, Number(sec) || 0)) : Math.max(0, Number(sec) || 0);
      this.currentTime = clamped;
      if (this.videoUrl && this.$refs.videoEl) {
        this.$refs.videoEl.currentTime = clamped;
      }
    },
    onScrub(e) {
      this.seekTo(Number(e.target?.value) || 0);
    },
    addScene() {
      if (!this.contentLoaded) return;
      this.markDirty();
      this.episode.scenes.push(normalizeScene({
        title: `${this.$t('creation.video.scenes')} ${this.scenes.length + 1}`,
        durationSec: 6,
        narration: '',
        caption: '',
        visualPrompt: '',
      }, this.scenes.length));
      this.editing = true;
    },
    moveScene(idx, delta) {
      const target = idx + delta;
      if (target < 0 || target >= this.scenes.length) return;
      this.markDirty();
      const [item] = this.episode.scenes.splice(idx, 1);
      this.episode.scenes.splice(target, 0, item);
    },
    deleteScene(idx) {
      this.markDirty();
      this.episode.scenes.splice(idx, 1);
    },
    async saveEpisode() {
      this.conflictError = '';
      this.saveError = '';
      const payload = {
        nodeId: this.node.id,
        content: JSON.stringify(this.episode, null, 2),
        baseRevId: this.editBaseRevId,
      };
      if (this.onSaveContent) {
        try {
          const res = await this.onSaveContent(payload);
          if (res?.conflict === true) {
            this.conflictError = this.$t('creation.interior.conflictDesc');
            return false;
          }
          this.editBaseRevId = res?.node?.currentRevId ?? this.loadedRevId ?? this.editBaseRevId;
          this.dirty = false;
          this.syncStoreDirty(false, payload.nodeId);
          return true;
        } catch (err) {
          if (err?.errorCode === 'revision_conflict') {
            this.conflictError = this.$t('creation.interior.conflictDesc');
          } else {
            this.saveError = err?.message || 'Save failed';
          }
          return false;
        }
      }
      this.$emit('save-content', payload);
      this.dirty = false;
      this.syncStoreDirty(false, payload.nodeId);
      return true;
    },
    requestAiRewriteScene(scene, idx) {
      this.$emit('request-ai-edit', {
        anchor: {
          kind: 'scene',
          nodeId: this.node.id,
          sceneId: scene.sceneId,
          label: `#${idx + 1} ${scene.title || ''}`.trim(),
        },
      });
    },
  },
  template: `
    <div class="creation-video-reader">
      <!-- Top Toolbar -->
      <div class="creation-reader-toolbar">
        <div class="creation-reader-meta">
          <span class="creation-kind-badge">
            {{ videoUrl ? $t('creation.video.sourceVideoMode') : $t('creation.video.storyboardMode') }}
          </span>
          <span class="creation-video-stats">{{ scenes.length }} {{ $t('creation.video.scenes') }} · {{ formattedTotalDuration }}</span>
          <span v-if="saving" class="creation-reader-saving">{{ $t('creation.interior.saving') }}</span>
        </div>

        <div class="creation-reader-actions">
          <select
            v-if="videoSources.length > 0"
            class="creation-compact-select"
            :value="episode.videoSourceId || ''"
            :aria-label="$t('creation.video.linkSource')"
            @change="onSelectVideoSource"
          >
            <option value="">{{ $t('creation.video.linkSource') }}</option>
            <option v-for="src in videoSources" :key="src.id" :value="src.id">
              {{ src.name || src.filename || src.id }}
            </option>
          </select>

          <button type="button" class="creation-glass-btn" :disabled="!contentLoaded" @click="addScene">
            + {{ $t('creation.video.addScene') }}
          </button>
          <button
            type="button"
            class="creation-glass-btn"
            :class="{ 'is-active': editing }"
            :disabled="!editing && !contentLoaded"
            @click="toggleEditing"
          >
            ✎ {{ editing ? $t('creation.book.doneEdit') : $t('creation.book.inlineEdit') }}
          </button>
          <button
            v-if="dirty"
            type="button"
            class="creation-glass-btn is-primary"
            :disabled="saving"
            @click="saveEpisode"
          >
            {{ $t('creation.interior.save') }}
          </button>
        </div>
      </div>

      <!-- Conflict / Save Error Banner -->
      <div v-if="conflictError || saveError" class="creation-conflict-banner" role="alert">
        <strong>⚠ {{ conflictError ? $t('creation.interior.conflictTitle') : saveError }}</strong>
        <span v-if="conflictError">{{ conflictError }}</span>
        <button type="button" class="creation-glass-btn" @click="conflictError = ''; saveError = ''">
          {{ $t('creation.canon.dismiss') }}
        </button>
      </div>

      <!-- Cinema Player + Synchronized Transcript Split -->
      <div class="creation-video-layout">
        <section class="creation-video-stage">
          <div v-if="videoUrl" class="creation-video-native-wrap">
            <video
              v-if="!playbackError"
              ref="videoEl"
              class="creation-video-el"
              controls
              preload="metadata"
              :src="videoUrl"
              @loadedmetadata="onVideoLoadedMetadata"
              @timeupdate="onVideoTimeUpdate"
              @error="onVideoError"
            ></video>
            <div v-else class="creation-video-fallback" role="alert">
              <p>{{ $t('creation.video.playbackError') }}</p>
              <a :href="videoUrl" download class="creation-glass-btn is-primary">
                ↓ {{ $t('creation.video.downloadFallback') }}
              </a>
            </div>
          </div>

          <div v-else class="creation-storyboard-player">
            <div class="creation-storyboard-screen">
              <img
                v-if="activeSceneVisualUrl"
                :src="activeSceneVisualUrl"
                :alt="activeScene?.title || ''"
                class="creation-storyboard-img"
              />
              <div v-else-if="activeScene" class="creation-storyboard-visual-card">
                <span class="creation-storyboard-shot">{{ activeScene.shotType || 'medium' }}</span>
                <h3 class="creation-storyboard-scene-title">{{ activeScene.title }}</h3>
                <p class="creation-storyboard-prompt">{{ activeScene.visualPrompt || $t('creation.video.captionPlaceholder') }}</p>
              </div>
              <div v-else class="creation-storyboard-empty">
                {{ $t('creation.video.emptyVideo') }}
              </div>

              <div v-if="activeScene && (activeScene.caption || activeScene.narration)" class="creation-storyboard-caption">
                {{ activeScene.caption || activeScene.narration }}
              </div>
            </div>

            <div class="creation-storyboard-controls">
              <button type="button" class="creation-glass-btn is-primary" :disabled="scenes.length === 0" @click="toggleStoryboardPlay">
                {{ playing ? '❚❚ ' + $t('creation.video.pause') : '▶ ' + $t('creation.video.play') }}
              </button>
              <span class="creation-storyboard-time">{{ formattedCurrentTime }} / {{ formattedTotalDuration }}</span>
              <input
                type="range"
                class="creation-storyboard-scrubber"
                min="0"
                :max="totalDuration || 1"
                step="0.1"
                :value="currentTime"
                @input="onScrub"
              />
            </div>
          </div>
        </section>

        <!-- Synchronized Interactive Transcript & Scene Cards -->
        <section class="creation-video-timeline">
          <div v-if="sceneTimeline.length === 0" class="creation-video-scenes-empty">
            <p>{{ $t('creation.video.emptyVideo') }}</p>
            <button
              type="button"
              class="creation-glass-btn is-primary"
              @click="$emit('request-ai-edit', { anchor: { kind: 'unit', nodeId: node.id, label: node.title } })"
            >
              ✦ {{ $t('creation.video.aiRewriteScene') }}
            </button>
          </div>

          <div
            v-for="entry in sceneTimeline"
            :key="entry.scene.sceneId"
            class="creation-scene-card"
            :class="{ 'is-active': activeScene && activeScene.sceneId === entry.scene.sceneId }"
            @click="seekTo(entry.start)"
          >
            <div class="creation-scene-head">
              <div class="creation-scene-id-group">
                <span class="creation-scene-timecode">{{ formatTime(entry.start) }}</span>
                <input
                  v-if="editing && contentLoaded"
                  v-model="entry.scene.title"
                  class="creation-inline-input"
                  @click.stop
                  @input="markDirty"
                />
                <strong v-else class="creation-scene-title">{{ entry.scene.title }}</strong>
              </div>
              <div class="creation-scene-controls" @click.stop>
                <label v-if="editing && contentLoaded" class="creation-scene-dur-wrap">
                  <input
                    v-model.number="entry.scene.durationSec"
                    type="number"
                    min="1"
                    max="300"
                    class="creation-num-input"
                    @input="markDirty"
                  />
                  <span>s</span>
                </label>
                <span v-else class="creation-scene-dur">
                  {{ $t('creation.video.sceneDuration', { seconds: entry.duration }) }}
                </span>
                <button type="button" class="creation-glass-btn" @click="requestAiRewriteScene(entry.scene, entry.idx)">
                  ✦ {{ $t('creation.video.aiRewriteScene') }}
                </button>
                <button type="button" class="creation-icon-mini" :disabled="entry.idx === 0" @click="moveScene(entry.idx, -1)">↑</button>
                <button type="button" class="creation-icon-mini" :disabled="entry.idx === scenes.length - 1" @click="moveScene(entry.idx, 1)">↓</button>
                <button type="button" class="creation-icon-mini is-danger" @click="deleteScene(entry.idx)">×</button>
              </div>
            </div>

            <div v-if="editing && contentLoaded" class="creation-scene-edit-fields" @click.stop>
              <label class="creation-field-label">
                <span>{{ $t('creation.video.transcript') }}</span>
                <textarea
                  v-model="entry.scene.narration"
                  class="creation-inline-textarea"
                  rows="2"
                  :placeholder="$t('creation.video.narrationPlaceholder')"
                  @input="markDirty"
                ></textarea>
              </label>
              <label class="creation-field-label">
                <span>{{ $t('creation.video.captionPlaceholder') }}</span>
                <input
                  v-model="entry.scene.caption"
                  class="creation-inline-input"
                  :placeholder="$t('creation.video.captionPlaceholder')"
                  @input="markDirty"
                />
              </label>
            </div>

            <div v-else class="creation-scene-body">
              <p v-if="entry.scene.narration" class="creation-scene-narration">{{ entry.scene.narration }}</p>
              <p v-if="entry.scene.caption && entry.scene.caption !== entry.scene.narration" class="creation-scene-caption">
                {{ entry.scene.caption }}
              </p>
              <p v-if="entry.scene.visualPrompt" class="creation-scene-prompt">
                {{ entry.scene.visualPrompt }}
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  `,
};
