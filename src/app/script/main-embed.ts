import './bb/base/polyfills';
import { KlApp } from './app/kl-app';
import { TKlEmbedProject, TKlProject } from './klecks/kl-types';
import { klPsdToKlProject, psdToKlPsd } from './klecks/storage/psd';
import { LANG } from './language/language';
import { loadAgPsd, TAgPsd } from './klecks/storage/load-ag-psd';
import { KL_CONFIG } from './klecks/kl-config';
import { asyncThrow, randomUuid } from './bb/base/base';
import { initIconCss } from './icon/icon';
import { getMixModeStr } from './klecks/canvas/get-mix-mode';
import { EmbedDraft, restoreDraft, TDraftRestored, TEmbedDraft } from './embed/embed-draft';
import { EmbedRecording, TRecordingInfo } from './embed/embed-recording';
import { KlrRecorder, TKlrChunks, TKlrInfo } from './klr/klr-recorder';
import { TKlrStart } from './klr/klr-format';
import { isLayerFill } from './klecks/kl-types';

// a project of plain fills is a blank start the .klr describes itself
function klrStartOf(project: TKlEmbedProject, url: string | undefined): TKlrStart {
    if (project.layers.every((layer) => isLayerFill(layer.image as any))) {
        return {
            kind: 'blank',
            layers: project.layers.map((layer) => ({
                name: layer.name,
                opacity: layer.opacity,
                isVisible: layer.isVisible ?? true,
                mixModeStr: getMixModeStr(layer.mixModeStr),
                hasClipping: layer.hasClipping ?? false,
                fill: (layer.image as { fill: string }).fill,
            })),
        };
    }
    return { kind: 'reference', url: url ?? '' };
}

initIconCss();

export type TEmbedParams = {
    project?: TKlEmbedProject;
    onSubmit: (onSuccess: () => void, onError: () => void) => void;
    embedUrl?: string;
    logoImg?: string;
    bottomBar?: HTMLElement;
    aboutEl?: HTMLElement;
    disableAutoFit?: boolean; // disable automatic Fit to View for small canvases
    enableImageDropperImport?: boolean; // default false
    // Opt-in autosave through the embedder's storage. A draft.saved is opened instead of
    // project/openProject(), which are only used if it can't be read.
    draft?: TEmbedDraft;
    // Opt-in timelapse: an H.264 frame per history step, in the draft if there is one.
    // getRecording() gives the MP4s. Browsers without an H.264 VideoEncoder don't record.
    // 'klr': an input recording instead (klr/klr-recorder.ts), from getKlr()/getKlrChunks().
    recording?: boolean | 'klr';
    // the URL of the picture the session starts from (the previous version's PSD), when it is
    // not blank: a .klr names its start
    klrStartUrl?: string;
    // No images from outside Klecks: system-clipboard paste, drag and drop and image import
    // are off, with a note; copy and paste inside Klecks go through an in-memory clipboard.
    // Default: on with recording 'klr' (the recording holds no outside pixels), else off.
    blockOutsideImages?: boolean;
};

export type TReadPSD = {
    blob: Blob | ArrayBuffer;
    callback: (k: TKlProject | null) => void;
};

export function processEmbedProject(embedProject: TKlEmbedProject): TKlProject {
    return {
        ...embedProject,
        projectId: embedProject.projectId ?? randomUuid(),
        layers: embedProject.layers.map((layer) => ({
            ...layer,
            isVisible: layer.isVisible ?? true,
            hasClipping: layer.hasClipping ?? false,
            mixModeStr: getMixModeStr(layer.mixModeStr),
        })),
    };
}

/**
 * Note: Wrapped by EmbedWrapper, which quickly provides feedback for the user without having loaded everything.
 * Embed runs when the main bundle is loaded. It instantiates Klecks.
 */
export class Embed {
    private isInitialized: boolean = false;
    private klApp: KlApp | undefined;
    private readonly psdQueue: TReadPSD[] = []; // queue of psds waiting while ag-psd is loading
    private agPsd: TAgPsd | 'error' | undefined;
    private loadingScreenEl: HTMLElement | null;
    private loadingScreenTextEl: HTMLElement | null;
    private isRestoringDraft: boolean = false;
    private fallbackProject: TKlEmbedProject | undefined; // if draft.saved can't be read
    private restoredDraft: TDraftRestored | undefined;
    private recording: EmbedRecording | undefined;
    private klr: KlrRecorder | undefined;

    onProjectReady(embedProject: TKlEmbedProject) {
        if (this.isRestoringDraft) {
            this.fallbackProject = embedProject;
            return;
        }
        if (this.isInitialized) {
            if (!this.restoredDraft) {
                asyncThrow(new Error('Already called openProject'));
            }
            return;
        }

        try {
            this.isInitialized = true;
            const project = processEmbedProject(embedProject);
            this.klApp = new KlApp({
                project,
                bottomBar: this.p.bottomBar,
                aboutEl: this.p.aboutEl,
                embed: {
                    url: this.p.embedUrl,
                    enableImageDropperImport: !!this.p.enableImageDropperImport,
                    disableUnloadWarning: !!this.p.draft, // the embedder warns
                    blockOutsideImages: this.p.blockOutsideImages ?? this.p.recording === 'klr',
                    onSubmit: this.p.onSubmit,
                },
            });
            const restoredVideo = this.restoredDraft?.video;
            if (this.p.recording === 'klr') {
                try {
                    const api = this.klApp.getKlrApi();
                    this.klr = new KlrRecorder({
                        api,
                        start: this.restoredDraft
                            ? { kind: 'reference', url: this.p.klrStartUrl ?? '' } // phase 2
                            : klrStartOf(embedProject, this.p.klrStartUrl),
                    });
                } catch (e) {
                    console.error('Recording unavailable', e);
                }
            } else if (this.p.recording || restoredVideo?.clips.length) {
                // Without the option (or an encoder) a draft's recording is only carried along.
                try {
                    this.recording = new EmbedRecording({
                        klApp: this.klApp,
                        canEncode: !!this.p.recording,
                        restored: restoredVideo,
                    });
                } catch (e) {
                    console.error('Recording unavailable', e);
                }
            }
            if (this.p.draft) {
                new EmbedDraft({
                    klApp: this.klApp,
                    store: this.p.draft.store,
                    restored: this.restoredDraft,
                    recording: this.recording,
                });
            }

            void this.loadingScreenEl?.remove();
            this.loadingScreenEl = null;
            this.loadingScreenTextEl = null;

            document.body.append(this.klApp.getElement());
        } catch (e) {
            this.initError('' + e);
            console.error(e);
        }
    }

    // ----------------------------------- public -----------------------------------
    constructor(private p: TEmbedParams & { embedUrl: string }) {
        this.loadingScreenEl = document.getElementById('loading-screen');
        this.loadingScreenTextEl = document.getElementById('loading-screen-text');
        if (this.loadingScreenTextEl) {
            this.loadingScreenTextEl.textContent = LANG('embed-init-waiting');
        }

        if (p.disableAutoFit) {
            KL_CONFIG.disableAutoFit = true;
        }
        const draft = p.draft;
        if (draft?.saved) {
            this.isRestoringDraft = true;
            restoreDraft(draft.saved).then(
                (restored) => {
                    this.isRestoringDraft = false;
                    this.fallbackProject = undefined;
                    this.restoredDraft = restored;
                    this.onProjectReady(restored.project);
                },
                (error) => {
                    this.isRestoringDraft = false;
                    draft.store.unreadable(error);
                    if (this.fallbackProject) {
                        this.onProjectReady(this.fallbackProject);
                    }
                },
            );
        }
        if (p.project) {
            this.onProjectReady(p.project);
        }
    }

    openProject = (embedProject: TKlEmbedProject) => {
        this.onProjectReady(embedProject);
    };

    initError(error: string) {
        if (this.loadingScreenTextEl) {
            this.loadingScreenTextEl.textContent = '❌ ' + error;
        }
        if (this.loadingScreenEl) {
            this.loadingScreenEl.className += 'loading-screen-error';
        }
    }

    async getPNG(): Promise<Blob> {
        if (!this.klApp) {
            throw new Error('App not initialized');
        }
        return await this.klApp.getPNG();
    }

    async getPSD(): Promise<Blob> {
        if (!this.klApp) {
            throw new Error('App not initialized');
        }
        return await this.klApp.getPSD();
    }

    // One video/mp4 per clip, in order; empty without a recording. Never throws.
    async getRecording(): Promise<Blob[]> {
        try {
            return this.recording ? await this.recording.getClips() : [];
        } catch (e) {
            console.error('Recording unavailable', e);
            return [];
        }
    }

    getRecordingInfo(): TRecordingInfo | null {
        return this.recording ? this.recording.getInfo() : null;
    }

    // the whole .klr (seals the open chunk), or null without the 'klr' recording
    getKlr(): Uint8Array | null {
        return this.klr ? this.klr.getBytes() : null;
    }

    // head + sealed chunks + the open one, concatenated they are the .klr (for drafts)
    getKlrChunks(): TKlrChunks | null {
        return this.klr ? this.klr.getChunks() : null;
    }

    getKlrInfo(): TKlrInfo | null {
        return this.klr ? this.klr.getInfo() : null;
    }

    readPSDs(psds: TReadPSD[]) {
        if (psds.length === 0) {
            return;
        }

        const readItem = (item: TReadPSD) => {
            try {
                const psd = (this.agPsd as any).readPsd(item.blob as any);
                const project = klPsdToKlProject(psdToKlPsd(psd));
                item.callback(project);
            } catch (e) {
                console.error('failed to read psd', e);
                item.callback(null);
            }
        };

        // library is not loaded yet
        if (!this.agPsd) {
            if (this.psdQueue.length === 0) {
                (async () => {
                    try {
                        this.agPsd = await loadAgPsd();
                    } catch (e) {
                        this.agPsd = 'error';
                    }
                    while (this.psdQueue.length > 0) {
                        readItem(this.psdQueue.shift()!);
                    }
                })();
            }
            psds.forEach((item) => {
                this.psdQueue.push(item);
            });
        } else {
            psds.forEach(readItem);
        }
    }
}
