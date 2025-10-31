import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { editIcon } from '@jupyterlab/ui-components';

type ToolMode = 'pen' | 'highlighter';
type StrokeBasis = {
  width: number;
  height: number;
  minY: number;
  maxY: number;
  anchorLine?: number;
  anchorLineTop?: number;
};
type Stroke = {
  tool: ToolMode;
  width: number;
  color: string;
  alpha?: number;
  points: [number, number][];
  basis?: StrokeBasis;
};
type OverlayState = {
  button: HTMLButtonElement;
  canvas: HTMLCanvasElement;
  wrapper?: HTMLElement;
  floating?: HTMLButtonElement;
  palette?: HTMLDivElement;
  toggle: (force?: boolean) => boolean;
  setTool: (tool: ToolMode) => void;
  setColor: (color: string) => void;
  setWidth: (width: number) => void;
  clear: () => void;
  erasing?: boolean;
  setEraser?: (on: boolean) => void;
};
const META_KEY = 'overlay_v1';
const BASE_ERASER_RADIUS = 0.015;

const activeOverlays = new Set<OverlayState>();
let stylesInjected = false;
let pointerGuardInstalled = false;

const ensureOverlayStyles = () => {
  if (stylesInjected) {
    return;
  }
  stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'jupyter-annotation-tool-ipynbd-styles';
  style.textContent = `
.jp-CellOverlayButtonWrapper {
  display: flex;
  align-items: center;
}

button.jp-CellOverlayButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  margin-left: 4px;
  height: 24px;
  border: none;
  border-radius: var(--jp-border-radius);
  background: transparent;
  color: inherit;
  cursor: pointer;
  line-height: 1;
}

button.jp-CellOverlayButton svg {
  width: 16px;
  height: 16px;
}

button.jp-CellOverlayButton.jp-mod-active {
  background: var(--jp-layout-color2);
  color: var(--jp-ui-font-color0);
}

button.jp-CellOverlayButton:focus-visible {
  outline: 2px solid var(--jp-brand-color1);
  outline-offset: 1px;
}

button.jp-CellOverlayFloatingButton {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 28px;
  height: 28px;
  display: none;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.45);
  color: var(--jp-ui-font-color1);
  z-index: 60;
  cursor: pointer;
  pointer-events: auto;
}

button.jp-CellOverlayFloatingButton svg {
  width: 16px;
  height: 16px;
}

button.jp-CellOverlayFloatingButton.jp-mod-active {
  display: flex;
  background: var(--jp-brand-color1);
  color: var(--jp-ui-inverse-font-color0);
  box-shadow: 0 2px 4px rgba(0,0,0,0.3);
}

.jp-CellOverlayToolbar {
  position: absolute;
  top: 42px;
  right: 6px;
  display: none;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border-radius: 6px;
  background: rgba(17, 17, 17, 0.85);
  color: var(--jp-ui-font-color1);
  z-index: 60;
  min-width: 140px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.35);
}

.jp-CellOverlayToolbar.jp-mod-visible {
  display: flex;
}

.jp-CellOverlayToolbar button,
.jp-CellOverlayToolbar input[type="color"],
.jp-CellOverlayToolbar input[type="range"] {
  font-size: 12px;
  border: none;
  border-radius: 4px;
  padding: 4px 6px;
  background: var(--jp-layout-color1);
  color: inherit;
  cursor: pointer;
}

.jp-CellOverlayToolbar button.jp-mod-active {
  background: var(--jp-brand-color1);
  color: var(--jp-ui-inverse-font-color0);
}

.jp-CellOverlayToolbar .jp-OverlayToolbarRow {
  display: flex;
  gap: 4px;
  align-items: center;
}

.jp-CellOverlayToolbar label {
  font-size: 11px;
  opacity: 0.85;
}
`;
  document.head.appendChild(style);
};

const installPointerGuard = () => {
  if (pointerGuardInstalled) {
    return;
  }
  pointerGuardInstalled = true;
  document.addEventListener(
    'pointerdown',
    event => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      activeOverlays.forEach(state => {
        if (
          state.canvas.contains(target) ||
          state.button.contains(target) ||
          (state.wrapper?.contains(target) ?? false) ||
          (state.floating?.contains(target) ?? false) ||
          (state.palette?.contains(target) ?? false)
        ) {
          return;
        }
        state.toggle(false);
      });
    },
    true
  );
};

const findCellToolbar = (cellNode: HTMLElement): HTMLElement | null => {
  const knownToolbar = cellNode.querySelector(
    '.jp-CellHeader .jp-Toolbar, .jp-Cell-header .jp-Toolbar, .jp-NotebookCellToolbar .jp-Toolbar, .jp-Cell-toolbar .jp-Toolbar'
  ) as HTMLElement | null;
  if (knownToolbar) {
    return knownToolbar;
  }

  const buttonSelectors = [
    'button[title*="Delete"]',
    'button[aria-label*="Delete"]',
    'button[data-command*="delete"]',
    'button[title*="Copy"]',
    'button[data-command*="copy"]'
  ];
  for (const selector of buttonSelectors) {
    const btn = cellNode.querySelector(selector) as HTMLElement | null;
    if (btn) {
      const toolbar = btn.closest('.jp-Toolbar') as HTMLElement | null;
      if (toolbar) {
        return toolbar;
      }
    }
  }

  const toolbars = cellNode.querySelectorAll('.jp-Toolbar');
  if (toolbars.length === 1) {
    return toolbars[0] as HTMLElement;
  }
  return null;
};

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyter-annotation-tool-ipynbd:plugin',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    console.log('[jupyter-annotation-tool-ipynbd] plugin activate');  // <-- visible in browser console
    ensureOverlayStyles();
    installPointerGuard();

    tracker.widgetAdded.connect((_tracker: INotebookTracker, panel: NotebookPanel) => {
      void panel.context.ready.then(() => {
        const nb = panel.content;

        // --- Attach overlay handlers to each cell
        const attach = (cell: any) => {
          if ((cell.node as any).__overlayAttached) return;
          (cell.node as any).__overlayAttached = true;

          const content = (cell.node.querySelector('.jp-Cell-content') as HTMLElement) ?? (cell.node as HTMLElement);
          const canvas = ensureCanvas(cell, content);
          const ctx = canvas.getContext('2d')!;

          let down = false;
          let current: Stroke | null = null;
          let erasingActive = false;
          let erasingPointerId: number | null = null;
          let lastErasePoint: [number, number] | null = null;

          type OverlayMeta = { strokes?: Stroke[]; [key: string]: unknown };
          const getSharedModel = (): any => (cell.model as any)?.sharedModel ?? null;
          const cloneOverlay = <T>(input: T): T => {
            if (typeof structuredClone === 'function') {
              try {
                return structuredClone(input);
              } catch (err) {
                /* ignore structuredClone failure */
              }
            }
            try {
              return JSON.parse(JSON.stringify(input));
            } catch (err) {
              return input;
            }
          };
          const readMeta = (): OverlayMeta => {
            const shared = getSharedModel();
            if (shared && typeof shared.getMetadata === 'function') {
              const sharedValue = shared.getMetadata(META_KEY) as OverlayMeta | undefined;
              if (sharedValue && typeof sharedValue === 'object') {
                return cloneOverlay(sharedValue);
              }
            }
            if (typeof cell.model.getMetadata === 'function') {
              const value = cell.model.getMetadata(META_KEY) as OverlayMeta | undefined;
              if (value && typeof value === 'object') {
                return cloneOverlay(value);
              }
            }
            return { strokes: [] };
          };
          const writeMeta = (value: OverlayMeta) => {
            const shared = getSharedModel();
            const payload = cloneOverlay(value);
            if (shared && typeof shared.setMetadata === 'function') {
              shared.setMetadata(META_KEY, payload);
              return;
            }
            if (typeof cell.model.setMetadata === 'function') {
              cell.model.setMetadata(META_KEY, payload);
            }
          };

          const sharedModelRef = getSharedModel();

          const fit = () => {
            const r = content.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.max(1, Math.floor(r.width * dpr));
            canvas.height = Math.max(1, Math.floor(r.height * dpr));
            canvas.style.width = r.width + 'px';
            canvas.style.height = r.height + 'px';
            ctx.setTransform(dpr,0,0,dpr,0,0);
            redraw();
          };

          const toNorm = (e: PointerEvent): [number, number] => {
            const r = canvas.getBoundingClientRect();
            return [(e.clientX - r.left)/r.width, (e.clientY - r.top)/r.height];
          };

          const drawStroke = (s: Stroke) => {
            const W = canvas.clientWidth || 1;
            const H = canvas.clientHeight || 1;
            const basisWidth = s.basis?.width && s.basis.width > 0 ? s.basis.width : W;
            const basisHeight = s.basis?.height && s.basis.height > 0 ? s.basis.height : H;
            const actualWidth = basisWidth;
            const actualHeight = basisHeight;

            let deltaY = 0;
            const anchorLine = s.basis?.anchorLine;
            const anchorLineTopNorm = s.basis?.anchorLineTop;
            if (
              H >= actualHeight &&
              anchorLine !== undefined &&
              anchorLineTopNorm !== undefined &&
              cell.editor
            ) {
              const lineCoord = cell.editor.getCoordinateForPosition({
                line: anchorLine,
                column: 0
              });
              if (lineCoord) {
                const contentRect = content.getBoundingClientRect();
                const newTop = lineCoord.top - contentRect.top;
                const originalTop = anchorLineTopNorm * actualHeight;
                deltaY = newTop - originalTop;
              }
            }

            ctx.save();
            ctx.globalAlpha = s.tool === 'highlighter' ? (s.alpha ?? 0.3) : 1;
            ctx.lineWidth = s.width * actualWidth;
            ctx.strokeStyle = s.color;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            s.points.forEach(([nx, ny], i) => {
              const x = nx * actualWidth;
              const y = ny * actualHeight + deltaY;
              i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            });
            ctx.stroke();
            ctx.restore();
          };

          const redraw = () => {
            ctx.clearRect(0,0,canvas.width,canvas.height);
            const meta = readMeta();
            const strokes = Array.isArray(meta.strokes) ? meta.strokes : [];
            strokes.forEach(drawStroke);
            if (current) drawStroke(current);
          };

          // default tool settings
          const penSettings = { color: '#ff5722', width: 0.003 };
          const highlighterSettings = { color: '#ffff00', width: 0.01 };
          let tool: ToolMode = 'pen';
          let widthNorm = penSettings.width;
          let color = penSettings.color;
          let erasing = false;
          let currentTool: ToolMode = tool;
          let currentColor = color;
          let currentWidth = widthNorm;

          const blockEvent = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
          };

          ['mousedown', 'click', 'dblclick', 'mouseup', 'contextmenu'].forEach(type => {
            canvas.addEventListener(type, blockEvent, true);
          });

          const enforceCommandMode = () => {
            nb.mode = 'command';
            nb.activeCell?.editor?.blur();
          };

          let wrapper = (cell.node as any).__overlayWrapper as HTMLElement | undefined;
          let drawBtn = (cell.node as any).__overlayButton as HTMLButtonElement | undefined;
          let floatingBtn: HTMLButtonElement | undefined;
          let palette: HTMLDivElement | undefined;

          const ensureButton = () => {
            if (!drawBtn) {
              drawBtn = document.createElement('button');
              drawBtn.type = 'button';
              drawBtn.className = 'jp-ToolbarButtonComponent jp-Button-flat jp-CellOverlayButton';
              drawBtn.title = 'Draw on cell';
              drawBtn.setAttribute('aria-pressed', 'false');
              editIcon.element({ container: drawBtn });
            }
            if (!wrapper) {
              wrapper = document.createElement('div');
              wrapper.className = 'jp-Toolbar-item jp-CellOverlayButtonWrapper';
            }
            if (!drawBtn.isConnected) {
              wrapper.appendChild(drawBtn);
            }
            const attach = () => {
              const toolbar = findCellToolbar(cell.node);
              if (!toolbar) {
                requestAnimationFrame(attach);
                return;
              }
              if (!wrapper!.isConnected) {
                toolbar.appendChild(wrapper!);
              }
            };
            attach();

            (cell.node as any).__overlayWrapper = wrapper;
            (cell.node as any).__overlayButton = drawBtn;
          };

          if (!drawBtn || !wrapper || !wrapper.isConnected) {
            ensureButton();
          }

          const reinforceButton = () => ensureButton();
          cell.node.addEventListener('focusin', reinforceButton);

          const setButtonState = (on: boolean) => {
            if (drawBtn) {
              drawBtn.classList.toggle('jp-mod-active', on);
              drawBtn.setAttribute('aria-pressed', String(on));
              drawBtn.style.opacity = on ? '1' : '0.6';
            }
            if (floatingBtn) {
              floatingBtn.classList.toggle('jp-mod-active', on);
              floatingBtn.setAttribute('aria-pressed', String(on));
              floatingBtn.style.display = on ? 'flex' : 'none';
            }
          };

          let overlayState: OverlayState;
          let penBtnRef: HTMLButtonElement | null = null;
          let highlighterBtnRef: HTMLButtonElement | null = null;
          let eraserBtnRef: HTMLButtonElement | null = null;
          let colorInputRef: HTMLInputElement | null = null;
          let widthInputRef: HTMLInputElement | null = null;

          const findFloatingButton = (): HTMLButtonElement | undefined =>
            Array.from(content.children).find(
              (el): el is HTMLButtonElement =>
                el instanceof HTMLButtonElement && el.dataset.overlayToggle === 'floating'
            );

          const findPaletteElement = (): HTMLDivElement | undefined =>
            Array.from(content.children).find(
              (el): el is HTMLDivElement =>
                el instanceof HTMLDivElement && el.dataset.overlay === 'palette'
            );

          floatingBtn = findFloatingButton();
          palette = findPaletteElement();

          const syncPaletteState = () => {
            if (!palette) {
              return;
            }
            if (penBtnRef) {
              penBtnRef.classList.toggle('jp-mod-active', !erasing && currentTool === 'pen');
            }
            if (highlighterBtnRef) {
              highlighterBtnRef.classList.toggle('jp-mod-active', !erasing && currentTool === 'highlighter');
            }
            if (eraserBtnRef) {
              eraserBtnRef.classList.toggle('jp-mod-active', erasing);
            }
            if (colorInputRef && colorInputRef.value !== currentColor) {
              colorInputRef.value = currentColor;
            }
            if (widthInputRef) {
              const target = String(Math.round(currentWidth * 2000));
              if (widthInputRef.value !== target) {
                widthInputRef.value = target;
              }
            }
          };

          const ensurePalette = () => {
            if (!palette) {
              palette = document.createElement('div');
              palette.dataset.overlay = 'palette';
              palette.className = 'jp-CellOverlayToolbar';

              const toolRow = document.createElement('div');
              toolRow.className = 'jp-OverlayToolbarRow';

              penBtnRef = document.createElement('button');
              penBtnRef.textContent = 'Pen';
              penBtnRef.addEventListener('click', () => {
                setEraser(false);
                setTool('pen');
              });

              highlighterBtnRef = document.createElement('button');
              highlighterBtnRef.textContent = 'Highlighter';
              highlighterBtnRef.addEventListener('click', () => {
                setEraser(false);
                setTool('highlighter');
              });

              eraserBtnRef = document.createElement('button');
              eraserBtnRef.textContent = 'Eraser';
              eraserBtnRef.addEventListener('click', () => setEraser(!erasing));

              toolRow.append(penBtnRef, highlighterBtnRef, eraserBtnRef);

              const colorRow = document.createElement('div');
              colorRow.className = 'jp-OverlayToolbarRow';
              const colorLabel = document.createElement('label');
              colorLabel.textContent = 'Color';
              colorInputRef = document.createElement('input');
              colorInputRef.type = 'color';
              colorInputRef.value = currentColor;
              colorInputRef.addEventListener('input', () => setColor(colorInputRef!.value));
              colorRow.append(colorLabel, colorInputRef);

              const widthRow = document.createElement('div');
              widthRow.className = 'jp-OverlayToolbarRow';
              const widthLabel = document.createElement('label');
              widthLabel.textContent = 'Width';
              widthInputRef = document.createElement('input');
              widthInputRef.type = 'range';
              widthInputRef.min = '1';
              widthInputRef.max = '10';
              widthInputRef.value = String(Math.round(currentWidth * 2000));
              widthInputRef.addEventListener('input', () => setWidth(Number(widthInputRef!.value) / 2000));
              widthRow.append(widthLabel, widthInputRef);

              const clearBtn = document.createElement('button');
              clearBtn.textContent = 'Clear';
              clearBtn.addEventListener('click', () => clearStrokes());

              palette.append(toolRow, colorRow, widthRow, clearBtn);
              content.appendChild(palette);
            }
            if (overlayState) {
              overlayState.palette = palette;
            }
            syncPaletteState();
            return palette;
          };

          const setTool = (next: ToolMode) => {
            erasing = false;
            tool = next;
            currentTool = next;
            if (next === 'pen') {
              color = penSettings.color;
              widthNorm = penSettings.width;
            } else {
              color = highlighterSettings.color;
              widthNorm = highlighterSettings.width;
            }
            currentColor = color;
            currentWidth = widthNorm;
            if (overlayState) {
              overlayState.erasing = false;
            }
            syncPaletteState();
          };

          const setEraser = (on: boolean) => {
            if (erasingPointerId !== null && canvas.hasPointerCapture(erasingPointerId)) {
              canvas.releasePointerCapture(erasingPointerId);
            }
            erasingActive = false;
            erasingPointerId = null;
            lastErasePoint = null;
            if (on) {
              down = false;
              current = null;
            }
            erasing = on;
            if (overlayState) {
              overlayState.erasing = on;
            }
            syncPaletteState();
          };

          const setColor = (next: string) => {
            currentColor = next;
            if (currentTool === 'pen') {
              penSettings.color = next;
            } else {
              highlighterSettings.color = next;
            }
            color = next;
            syncPaletteState();
          };

          const setWidth = (next: number) => {
            currentWidth = next;
            if (currentTool === 'pen') {
              penSettings.width = next;
            } else {
              highlighterSettings.width = next;
            }
            widthNorm = next;
            syncPaletteState();
          };

          const clearStrokes = () => {
            setEraser(false);
            const meta = readMeta();
            meta.strokes = [];
            writeMeta(meta);
            redraw();
          };

          const showPalette = (on: boolean) => {
            if (on) {
              const panel = ensurePalette();
              panel.classList.add('jp-mod-visible');
            } else if (palette) {
              palette.classList.remove('jp-mod-visible');
            }
          };

          const distanceSquared = (a: [number, number], b: [number, number]) => {
            const dx = a[0] - b[0];
            const dy = a[1] - b[1];
            return dx * dx + dy * dy;
          };

          const pointToSegmentDistanceSquared = (
            p: [number, number],
            a: [number, number],
            b: [number, number]
          ) => {
            if (a[0] === b[0] && a[1] === b[1]) {
              return distanceSquared(p, a);
            }
            const vx = b[0] - a[0];
            const vy = b[1] - a[1];
            const wx = p[0] - a[0];
            const wy = p[1] - a[1];
            const c1 = vx * wx + vy * wy;
            const c2 = vx * vx + vy * vy;
            const t = Math.max(0, Math.min(1, c1 / c2));
            const proj: [number, number] = [a[0] + t * vx, a[1] + t * vy];
            return distanceSquared(p, proj);
          };

          const segmentDistanceSquared = (
            a1: [number, number],
            a2: [number, number],
            b1: [number, number],
            b2: [number, number]
          ) => {
            return Math.min(
              pointToSegmentDistanceSquared(a1, b1, b2),
              pointToSegmentDistanceSquared(a2, b1, b2),
              pointToSegmentDistanceSquared(b1, a1, a2),
              pointToSegmentDistanceSquared(b2, a1, a2)
            );
          };

          const eraseWithPointer = (
            point: [number, number],
            previous?: [number, number] | null
          ) => {
            const meta = readMeta();
            const strokes = Array.isArray(meta.strokes) ? meta.strokes : [];
            const pointerSegment = previous ? [previous, point] as [[number, number], [number, number]] : null;
            let modified = false;
            const nextStrokes: Stroke[] = [];

            const radiusForStroke = (stroke: Stroke) => {
              const width = stroke.width ?? 0.003;
              return Math.max(BASE_ERASER_RADIUS, width * 6);
            };

            for (const stroke of strokes) {
              const pts = Array.isArray(stroke.points) ? stroke.points : [];
              if (pts.length === 0) {
                nextStrokes.push(stroke);
                continue;
              }

              const radius = radiusForStroke(stroke);
              const radiusSq = radius * radius;

              const keepPoint = (pt: [number, number]) => {
                if (distanceSquared(pt, point) <= radiusSq) {
                  return false;
                }
                if (previous && distanceSquared(pt, previous) <= radiusSq) {
                  return false;
                }
                if (pointerSegment) {
                  if (pointToSegmentDistanceSquared(pt, pointerSegment[0], pointerSegment[1]) <= radiusSq) {
                    return false;
                  }
                }
                return true;
              };

              const newSegments: [number, number][][] = [];
              let currentSegment: [number, number][] = [];
              let strokeModified = false;

              pts.forEach(pt => {
                const keep = keepPoint(pt);
                if (!keep) {
                  if (currentSegment.length > 1) {
                    newSegments.push(currentSegment);
                  }
                  currentSegment = [];
                  strokeModified = true;
                  return;
                }

                if (currentSegment.length === 0) {
                  currentSegment.push(pt);
                  return;
                }

                const prevPt = currentSegment[currentSegment.length - 1];
                const crosses = pointerSegment
                  ? segmentDistanceSquared(prevPt, pt, pointerSegment[0], pointerSegment[1]) <= radiusSq
                  : false;
                if (crosses) {
                  if (currentSegment.length > 1) {
                    newSegments.push(currentSegment);
                  }
                  currentSegment = [pt];
                  strokeModified = true;
                  return;
                }

                currentSegment.push(pt);
              });

              if (currentSegment.length > 1) {
                newSegments.push(currentSegment);
              }

              if (!strokeModified) {
                nextStrokes.push(stroke);
                continue;
              }

              modified = true;

              if (newSegments.length === 0) {
                continue;
              }

              for (const segment of newSegments) {
                if (segment.length < 2) {
                  continue;
                }
                const segBasis = stroke.basis
                  ? {
                      ...stroke.basis,
                      minY: Math.min(...segment.map(([, y]) => y)),
                      maxY: Math.max(...segment.map(([, y]) => y))
                    }
                  : undefined;
                nextStrokes.push({
                  ...stroke,
                  points: segment,
                  basis: segBasis
                });
              }
            }

            if (modified) {
              writeMeta({ ...meta, strokes: nextStrokes });
              redraw();
            }
          };

          const toggleOverlay = (force?: boolean) => {
            const enable = force ?? canvas.style.pointerEvents !== 'auto';
            canvas.style.pointerEvents = enable ? 'auto' : 'none';
            setButtonState(enable);
            showPalette(enable);
            overlayState.erasing = erasing;
            if (enable) {
              nb.mode = 'command';
              nb.activeCell?.editor?.blur();
              activeOverlays.add(overlayState);
            } else {
              activeOverlays.delete(overlayState);
            }
            return enable;
          };
          const onFloatingClick = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            toggleOverlay(canvas.style.pointerEvents === 'auto' ? false : true);
          };

          const ensureFloatingButton = () => {
            if (!floatingBtn) {
              floatingBtn = document.createElement('button');
              floatingBtn.type = 'button';
              floatingBtn.dataset.overlayToggle = 'floating';
              floatingBtn.className = 'jp-CellOverlayFloatingButton';
              floatingBtn.setAttribute('aria-label', 'Toggle drawing overlay');
              floatingBtn.setAttribute('aria-pressed', 'false');
              floatingBtn.innerHTML = '';
              editIcon.element({ container: floatingBtn });
              floatingBtn.addEventListener('click', onFloatingClick);
              content.appendChild(floatingBtn);
            } else {
              if (!floatingBtn.isConnected) {
                content.appendChild(floatingBtn);
              }
            }
            return floatingBtn;
          };

          overlayState = {
            button: drawBtn!,
            canvas,
            wrapper,
            floating: floatingBtn,
            palette,
            toggle: () => false,
            setTool,
            setColor,
            setWidth,
            clear: clearStrokes,
            setEraser,
            erasing
          };

          overlayState.toggle = toggleOverlay;
          overlayState.setTool = setTool;
          overlayState.setColor = setColor;
          overlayState.setWidth = setWidth;
          overlayState.clear = clearStrokes;
          overlayState.setEraser = setEraser;
          overlayState.erasing = erasing;

          floatingBtn = ensureFloatingButton();
          overlayState.floating = floatingBtn;
          showPalette(canvas.style.pointerEvents === 'auto');
          setButtonState(canvas.style.pointerEvents === 'auto');
          (cell.node as any).__overlayToggle = toggleOverlay;
          (cell.node as any).__overlayState = overlayState;

          if (drawBtn) {
            const buttonEl = drawBtn;
            const wrapperEl = wrapper;
            const handleButtonClick = (event: MouseEvent) => {
              event.preventDefault();
              event.stopPropagation();
              const widgets = Array.from(nb.widgets);
              const index = widgets.indexOf(cell);
              if (index >= 0) {
                nb.activeCellIndex = index;
              }
              toggleOverlay();
            };
            buttonEl.addEventListener('click', handleButtonClick);
            cell.disposed.connect(() => {
              activeOverlays.delete(overlayState);
              buttonEl.removeEventListener('click', handleButtonClick);
              wrapperEl?.remove();
              cell.node.removeEventListener('focusin', reinforceButton);
              floatingBtn?.removeEventListener('click', onFloatingClick);
              palette?.remove();
              palette = undefined;
              penBtnRef = highlighterBtnRef = eraserBtnRef = null;
              colorInputRef = widthInputRef = null;
              floatingBtn?.remove();
              floatingBtn = undefined;
              if (sharedModelRef && typeof sharedModelRef.metadataChanged?.disconnect === 'function') {
                try {
                  sharedModelRef.metadataChanged.disconnect(onMetadataChanged);
                } catch (err) {
                  /* ignore disconnect errors */
                }
              }
            });
          }

          canvas.addEventListener('pointerdown', e => {
            if (canvas.style.pointerEvents !== 'auto') return;
            blockEvent(e);
            enforceCommandMode();

            if (erasing) {
              const normPoint = toNorm(e);
              erasingActive = true;
              erasingPointerId = e.pointerId;
              canvas.setPointerCapture(e.pointerId);
              eraseWithPointer(normPoint, lastErasePoint);
              lastErasePoint = normPoint;
              return;
            }

            erasingActive = false;
            erasingPointerId = null;
            lastErasePoint = null;
            canvas.setPointerCapture(e.pointerId);
            down = true;
            const firstPoint = toNorm(e);
            current = {
              tool,
              width: widthNorm,
              color,
              alpha: tool === 'highlighter' ? 0.3 : 1,
              points: [firstPoint],
              basis: {
                width: canvas.clientWidth || 1,
                height: canvas.clientHeight || 1,
                minY: firstPoint[1],
                maxY: firstPoint[1]
              }
            };
            redraw();
            requestAnimationFrame(() => {
              if (down) {
                enforceCommandMode();
              }
            });
          });
          canvas.addEventListener('pointermove', e => {
            if (erasingActive) {
              blockEvent(e);
              const normPoint = toNorm(e);
              eraseWithPointer(normPoint, lastErasePoint);
              lastErasePoint = normPoint;
              enforceCommandMode();
              return;
            }
            if (!down || !current) return;
            blockEvent(e);
            const point = toNorm(e);
            current.points.push(point);
            if (current.basis) {
              current.basis = {
                ...current.basis,
                minY: Math.min(current.basis.minY, point[1]),
                maxY: Math.max(current.basis.maxY, point[1])
              };
            }
            redraw();
            enforceCommandMode();
          });
          const commitStroke = (pointerId?: number) => {
            if (!down || !current) return;
            down = false;
            const stroke = current;
            if (stroke.basis && cell.editor) {
              const editorHost = (cell.editorWidget?.node ?? (cell.editor as any)?.host) as HTMLElement | undefined;
              if (editorHost) {
                const basisHeight = stroke.basis.height || canvas.clientHeight || 1;
                const centerNorm = (stroke.basis.minY + stroke.basis.maxY) / 2;
                const centerPx = centerNorm * basisHeight;
                const contentRect = content.getBoundingClientRect();
                const editorRect = editorHost.getBoundingClientRect();
                const coordinate = {
                  left: editorRect.left + 5,
                  top: contentRect.top + centerPx
                };
                const linePos = cell.editor.getPositionForCoordinate(coordinate);
                if (linePos) {
                  const lineCoord = cell.editor.getCoordinateForPosition({
                    line: linePos.line,
                    column: 0
                  });
                  if (lineCoord) {
                    const lineTopRel = lineCoord.top - contentRect.top;
                    stroke.basis.anchorLine = linePos.line;
                    stroke.basis.anchorLineTop = lineTopRel / basisHeight;
                  }
                }
              }
            }
            const meta = readMeta();
            const strokes = Array.isArray(meta.strokes) ? [...meta.strokes] : [];
            strokes.push(stroke);
            writeMeta({ ...meta, strokes });
            current = null;
            redraw();
            if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) {
              canvas.releasePointerCapture(pointerId);
            }
          };
          const finishErasing = (pointerId?: number) => {
            if (!erasingActive) {
              return;
            }
            const id = pointerId ?? erasingPointerId;
            if (typeof id === 'number' && canvas.hasPointerCapture(id)) {
              canvas.releasePointerCapture(id);
            }
            erasingActive = false;
            erasingPointerId = null;
            lastErasePoint = null;
          };
          canvas.addEventListener('pointerup', e => {
            blockEvent(e);
            if (erasingActive) {
              finishErasing(e.pointerId);
              enforceCommandMode();
              return;
            }
            commitStroke(e.pointerId);
            enforceCommandMode();
          });
          canvas.addEventListener('pointercancel', e => {
            blockEvent(e);
            if (erasingActive) {
              finishErasing(e.pointerId);
              enforceCommandMode();
              return;
            }
            commitStroke(e.pointerId);
            enforceCommandMode();
          });

          const onMetadataChanged = (_: unknown, change: any) => {
            if (!change || typeof change !== 'object') {
              redraw();
              return;
            }
            if ('key' in change) {
              if (change.key === META_KEY) {
                redraw();
              }
              return;
            }
            if ('name' in change && change.name === META_KEY) {
              redraw();
            }
          };
          if (typeof (cell.model as any).metadataChanged?.connect === 'function') {
            (cell.model as any).metadataChanged.connect(onMetadataChanged);
          } else if ((cell.model.metadata as any)?.changed?.connect) {
            (cell.model.metadata as any).changed.connect(onMetadataChanged);
          }

          if (sharedModelRef && typeof sharedModelRef.metadataChanged?.connect === 'function') {
            sharedModelRef.metadataChanged.connect(onMetadataChanged);
          }

          new ResizeObserver(fit).observe(content);
          fit();
        };

        // attach to existing + future cells
        const observedCells = new WeakSet<any>();
        const refreshCells = () => {
          const cells = nb.model?.cells;
          if (!cells) {
            return;
          }
          nb.widgets.forEach(attach);
          if (!observedCells.has(cells)) {
            cells.changed.connect(() => nb.widgets.forEach(attach));
            observedCells.add(cells);
          }
        };

        refreshCells();
        nb.modelChanged.connect(() => {
          requestAnimationFrame(refreshCells);
        });
      });
    });

    // Helper to create/find the per-cell canvas
    function ensureCanvas(cell: any, content: HTMLElement): HTMLCanvasElement {
      content.style.position = 'relative';
      let canvas = content.querySelector(':scope > canvas[data-overlay="1"]') as HTMLCanvasElement | null;
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.dataset.overlay = '1';
        Object.assign(canvas.style, {
          position: 'absolute',
          inset: '0',
          zIndex: '50',
          pointerEvents: 'none',
          touchAction: 'none',
          cursor: 'crosshair'
        });
        content.appendChild(canvas);
      }
      return canvas;
    }
  }
};

export default plugin;
