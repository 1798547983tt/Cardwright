/**
 * The text cover drawn at 960×1440 for PNG export. It follows the same five styles as the library covers;
 * the numbers are the CSS container units scaled up (1cqw = 9.6px at 960 wide).
 */
import { coverFit } from '../../shared/card-studio/view';
import type { CardKind, CoverStyleId } from '../../shared/card-studio/types';

export const COVER_WIDTH = 960;
export const COVER_HEIGHT = 1440;
const U = COVER_WIDTH / 100;
/** A 1px CSS line on a cover about 300px wide, drawn at 960 wide. */
const HAIR = COVER_WIDTH / 300;
const SERIF = '"Noto Serif SC", "Source Han Serif SC", "STZhongsong", "SimSun", serif';
const SANS = '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const MONO = '"Cascadia Mono", Consolas, monospace';
const LATIN = '"Sitka Banner", Georgia, serif';

export interface CoverInput { style: CoverStyleId; name: string; kind: CardKind; source?: string }

const sub = (input: CoverInput) => input.kind === 'fan' ? `《${input.source || '原作'}》` : '原创';
const word = (input: CoverInput) => input.kind === 'fan' ? '同人' : '原创';
const fit = (input: CoverInput) => ({ 1: 1, 2: 0.76, 3: 0.58 }[coverFit(input.name)]);

/** Wraps horizontal text into lines that fit `width`, longest first. */
function lines(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const result: string[] = [];
  let current = '';
  for (const char of text) {
    const next = current + char;
    if (context.measureText(next).width > width && current) { result.push(current); current = char; }
    else current = next;
  }
  if (current) result.push(current);
  return result;
}

function drawWrapped(context: CanvasRenderingContext2D, text: string, x: number, bottom: number, width: number, size: number, lineHeight: number, align: CanvasTextAlign = 'left'): number {
  const rows = lines(context, text, width);
  context.textAlign = align;
  context.textBaseline = 'alphabetic';
  const height = rows.length * size * lineHeight;
  rows.forEach((row, index) => context.fillText(row, x, bottom - height + (index + 1) * size * lineHeight));
  return height;
}

/** Vertical right-to-left columns, as the 朱砂 cover uses for its title. */
function drawVertical(context: CanvasRenderingContext2D, text: string, right: number, top: number, maxHeight: number, size: number, tracking: number): void {
  const step = size * (1 + tracking);
  const perColumn = Math.max(1, Math.floor(maxHeight / step));
  context.textAlign = 'center';
  context.textBaseline = 'top';
  [...text].forEach((char, index) => {
    const column = Math.floor(index / perColumn);
    const row = index % perColumn;
    context.fillText(char, right - column * (size * 1.25), top + row * step);
  });
}

function background(context: CanvasRenderingContext2D, style: CoverStyleId): void {
  if (style === 'vermilion') {
    const gradient = context.createRadialGradient(COVER_WIDTH * 0.7, COVER_HEIGHT * 0.12, 0, COVER_WIDTH * 0.7, COVER_HEIGHT * 0.12, COVER_WIDTH * 1.2);
    gradient.addColorStop(0, '#2a1a14'); gradient.addColorStop(0.6, '#17110f'); context.fillStyle = gradient;
  } else if (style === 'archive') context.fillStyle = '#101214';
  else if (style === 'terminal') context.fillStyle = '#f1f1ee';
  else if (style === 'theatre') {
    const gradient = context.createRadialGradient(COVER_WIDTH / 2, COVER_HEIGHT * 0.38, 0, COVER_WIDTH / 2, COVER_HEIGHT * 0.38, COVER_WIDTH);
    gradient.addColorStop(0, '#2a1e15'); gradient.addColorStop(0.7, '#15110e'); context.fillStyle = gradient;
  } else {
    const gradient = context.createRadialGradient(COVER_WIDTH / 2, COVER_HEIGHT * 0.4, 0, COVER_WIDTH / 2, COVER_HEIGHT * 0.4, COVER_WIDTH);
    gradient.addColorStop(0, '#1c261c'); gradient.addColorStop(0.72, '#141a14'); context.fillStyle = gradient;
  }
  context.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
}

/** Draws one text cover onto a 960×1440 canvas context. */
export function drawCover(context: CanvasRenderingContext2D, input: CoverInput): void {
  const scale = fit(input);
  context.save();
  background(context, input.style);
  if (input.style === 'vermilion') {
    // The halo is the CSS box-shadow ring: 5cqw wide, very faint.
    context.fillStyle = 'rgba(201, 71, 47, .07)';
    context.beginPath(); context.arc(COVER_WIDTH - 29 * U, 31 * U, 22 * U, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#c9472f';
    context.beginPath(); context.arc(COVER_WIDTH - 29 * U, 31 * U, 17 * U, 0, Math.PI * 2); context.fill();
    context.strokeStyle = 'rgba(168, 138, 90, .55)'; context.lineWidth = 1;
    context.beginPath(); context.moveTo(7 * U, 7 * U); context.lineTo(7 * U, COVER_HEIGHT - 7 * U); context.moveTo(COVER_WIDTH - 7 * U, 7 * U); context.lineTo(COVER_WIDTH - 7 * U, COVER_HEIGHT - 7 * U); context.stroke();
    context.fillStyle = '#efe3cf'; context.font = `700 ${15 * U * scale}px ${SERIF}`;
    drawVertical(context, input.name, 22 * U, 14 * U, 104 * U, 15 * U * scale, 0.08);
    // Like the CSS cover, the source line sits on the bottom margin (bottom: 12cqw), not at a fixed top.
    context.fillStyle = '#a88a5a'; context.font = `${5 * U}px ${SERIF}`;
    const subStep = 5 * U * 1.18;
    const subRows = Math.min([...sub(input)].length, Math.max(1, Math.floor(70 * U / subStep)));
    drawVertical(context, sub(input), COVER_WIDTH - 15.5 * U, COVER_HEIGHT - 12 * U - subRows * subStep, 70 * U, 5 * U, 0.18);
    context.strokeStyle = '#c9472f'; context.lineWidth = 2;
    context.strokeRect(14 * U, COVER_HEIGHT - 26 * U, 14 * U, 14 * U);
    context.fillStyle = '#c9472f'; context.font = `700 ${4.6 * U}px ${SERIF}`;
    drawVertical(context, word(input), 21 * U + 2.3 * U, COVER_HEIGHT - 24 * U, 12 * U, 4.6 * U, 0.1);
  } else if (input.style === 'archive') {
    const tint = context.createLinearGradient(0, COVER_HEIGHT * 0.55, 0, COVER_HEIGHT);
    tint.addColorStop(0, 'rgba(25, 167, 232, 0)'); tint.addColorStop(1, 'rgba(25, 167, 232, .08)');
    context.fillStyle = tint; context.fillRect(0, COVER_HEIGHT * 0.55, COVER_WIDTH, COVER_HEIGHT * 0.45);
    context.save();
    context.fillStyle = 'rgba(233, 236, 238, .045)'; context.font = `800 ${34 * U}px "Bahnschrift", "Segoe UI", sans-serif`;
    context.fontStretch = 'condensed';
    context.translate(-3 * U + 0.2 * 34 * U, 26 * U); context.rotate(Math.PI / 2); context.textAlign = 'left'; context.textBaseline = 'alphabetic';
    context.fillText('ARCHIVE', 0, 0);
    context.restore();
    context.fillStyle = '#19a7e8'; context.font = `${4.6 * U}px ${MONO}`; context.textAlign = 'left'; context.textBaseline = 'top';
    context.letterSpacing = `${0.1 * 4.6 * U}px`;
    context.fillText(`档案 // ${word(input)}卡`, 8 * U, 8 * U);
    context.letterSpacing = '0px';
    context.fillStyle = 'rgba(233, 236, 238, .22)';
    for (let row = 0; row < 13; row++) for (let column = 0; column < 9; column++) { context.beginPath(); context.arc((62 + column * 3.4) * U, (22 + row * 3.4) * U, HAIR, 0, Math.PI * 2); context.fill(); }
    context.fillStyle = '#e9ecee'; context.font = `800 ${12.5 * U * scale}px ${SANS}`;
    drawWrapped(context, input.name, 8 * U, COVER_HEIGHT - 22 * U, 84 * U, 12.5 * U * scale, 1.1);
    context.fillStyle = '#8b949b'; context.font = `${4.6 * U}px ${SANS}`; context.textAlign = 'left';
    context.fillText(sub(input), 8 * U, COVER_HEIGHT - 13 * U);
    context.fillStyle = '#19a7e8'; context.fillRect(8 * U, COVER_HEIGHT - 9 * U, 22 * U, 1.2 * U);
  } else if (input.style === 'terminal') {
    context.save();
    context.beginPath(); context.rect(0, 30 * U, COVER_WIDTH, 44 * U); context.clip();
    context.strokeStyle = 'rgba(18, 18, 18, .16)'; context.lineWidth = HAIR;
    for (let x = -44 * U; x < COVER_WIDTH + 44 * U; x += 3.2 * U * Math.SQRT2) { context.beginPath(); context.moveTo(x, 74 * U); context.lineTo(x + 44 * U, 30 * U); context.stroke(); }
    context.restore();
    context.strokeStyle = '#121212'; context.lineWidth = HAIR;
    context.beginPath(); context.arc(COVER_WIDTH - 25 * U, 49 * U, 11 * U, 0, Math.PI * 2); context.stroke();
    context.beginPath(); context.moveTo(COVER_WIDTH - 36 * U, 49 * U); context.lineTo(COVER_WIDTH - 14 * U, 49 * U); context.moveTo(COVER_WIDTH - 25 * U, 38 * U); context.lineTo(COVER_WIDTH - 25 * U, 60 * U); context.stroke();
    context.fillStyle = '#121212'; context.font = `600 ${4.8 * U}px ${MONO}`; context.textAlign = 'left'; context.textBaseline = 'top';
    context.fillText('[ 角色卡 ]', 7 * U, 7 * U);
    context.textAlign = 'right'; context.fillStyle = '#555'; context.fillText(`[ ${word(input)} ]`, COVER_WIDTH - 7 * U, 7 * U);
    context.font = `800 ${11.5 * U * scale}px ${SANS}`;
    const rows = lines(context, input.name, 86 * U);
    const bandHeight = rows.length * 11.5 * U * scale * 1.05 + 6 * U;
    context.fillStyle = '#ffe100'; context.fillRect(0, COVER_HEIGHT - 24 * U - bandHeight, COVER_WIDTH, bandHeight);
    context.fillStyle = '#121212';
    drawWrapped(context, input.name, 7 * U, COVER_HEIGHT - 27 * U, 86 * U, 11.5 * U * scale, 1.05);
    context.font = `600 ${4.8 * U}px ${SANS}`; context.textAlign = 'left';
    context.fillText(sub(input), 7 * U, COVER_HEIGHT - 12 * U);
  } else if (input.style === 'theatre') {
    context.strokeStyle = 'rgba(168, 131, 90, .6)'; context.lineWidth = 1.5;
    context.save(); context.translate(COVER_WIDTH / 2, COVER_HEIGHT * 0.34); context.scale(1, 0.37);
    context.beginPath(); context.arc(0, 0, 39 * U, 0, Math.PI * 2); context.stroke();
    context.strokeStyle = 'rgba(216, 116, 47, .7)';
    context.beginPath(); context.arc(0, 0, 28 * U, 0, Math.PI * 2); context.stroke();
    context.restore();
    context.fillStyle = '#d8742f';
    context.beginPath();
    const star = [[0, -6], [0.8, -0.8], [6, 0], [0.8, 0.8], [0, 6], [-0.8, 0.8], [-6, 0], [-0.8, -0.8]];
    star.forEach(([x, y], index) => { const px = COVER_WIDTH / 2 + x * U; const py = COVER_HEIGHT * 0.34 + y * U; index ? context.lineTo(px, py) : context.moveTo(px, py); });
    context.closePath(); context.fill();
    context.fillStyle = '#a89886'; context.font = `${3.8 * U}px ${LATIN}`; context.textAlign = 'center'; context.textBaseline = 'top';
    context.letterSpacing = `${0.5 * 3.8 * U}px`;
    context.fillText('剧院 · THÉÂTRE', COVER_WIDTH / 2 + 0.25 * 3.8 * U, 8 * U);
    context.fillStyle = '#efe4d6'; context.font = `600 ${12 * U * scale}px ${SERIF}`;
    context.letterSpacing = `${0.12 * 12 * U * scale}px`;
    drawWrapped(context, input.name, COVER_WIDTH / 2, COVER_HEIGHT - 24 * U, 88 * U, 12 * U * scale, 1.15, 'center');
    context.letterSpacing = `${0.1 * 4.4 * U}px`;
    context.fillStyle = '#a89886'; context.font = `italic ${4.4 * U}px ${SERIF}`; context.textAlign = 'center';
    context.fillText(sub(input), COVER_WIDTH / 2, COVER_HEIGHT - 14 * U);
    context.letterSpacing = '0px';
  } else {
    context.strokeStyle = 'rgba(184, 149, 90, .7)'; context.lineWidth = 1.5;
    context.strokeRect(5 * U, 5 * U, COVER_WIDTH - 10 * U, COVER_HEIGHT - 10 * U);
    context.strokeStyle = 'rgba(184, 149, 90, .28)';
    context.strokeRect(7.4 * U, 7.4 * U, COVER_WIDTH - 14.8 * U, COVER_HEIGHT - 14.8 * U);
    context.strokeStyle = '#d9bb7a'; context.lineWidth = HAIR;
    for (const [x, y] of [[5 * U, 5 * U], [COVER_WIDTH - 5 * U, COVER_HEIGHT - 5 * U]]) {
      context.save(); context.translate(x, y); context.rotate(Math.PI / 4); context.strokeRect(-3.5 * U, -3.5 * U, 7 * U, 7 * U); context.restore();
    }
    const oval = (radius: number) => { context.save(); context.translate(COVER_WIDTH / 2, 49 * U); context.scale(1, 33 / 28); context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.restore(); };
    context.lineWidth = HAIR;
    context.strokeStyle = 'rgba(217, 187, 122, .55)'; oval(28 * U); context.stroke();
    context.strokeStyle = 'rgba(217, 187, 122, .3)'; oval(26 * U); context.stroke();
    context.font = `${3.8 * U}px Georgia, ${LATIN}`; context.letterSpacing = `${0.12 * 3.8 * U}px`;
    const capsule = context.measureText('CARD · 角色卡').width + 6 * U;
    context.fillStyle = '#141a14'; context.strokeStyle = '#b8955a';
    context.beginPath(); context.roundRect(COVER_WIDTH / 2 - capsule / 2, 8.3 * U, capsule, 6 * U, 99); context.fill(); context.stroke();
    context.fillStyle = '#d9bb7a'; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillText('CARD · 角色卡', COVER_WIDTH / 2 + 0.06 * 3.8 * U, 11.4 * U);
    context.letterSpacing = '0px';
    context.textBaseline = 'alphabetic';
    context.font = `700 ${11.5 * U * scale}px ${SERIF}`;
    drawWrapped(context, input.name, COVER_WIDTH / 2, COVER_HEIGHT - 25 * U, 84 * U, 11.5 * U * scale, 1.15, 'center');
    context.fillStyle = '#b8a98a'; context.font = `${4.4 * U}px ${SERIF}`; context.textAlign = 'center';
    context.fillText(sub(input), COVER_WIDTH / 2, COVER_HEIGHT - 16 * U);
    context.save();
    context.translate(COVER_WIDTH - 15 * U, 60 * U); context.rotate(-14 * Math.PI / 180);
    context.strokeStyle = '#b8955a'; context.lineWidth = 1.5; context.strokeRect(-6 * U, -3.5 * U, 12 * U, 7 * U);
    context.fillStyle = '#b8955a'; context.font = `700 ${4.6 * U}px ${SERIF}`; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillText(word(input), 0, 0);
    context.restore();
  }
  context.restore();
}

/** Renders the cover to a PNG data URL: the uploaded image when there is one, the text cover otherwise. */
export async function renderCoverPng(input: CoverInput, uploaded: string | null): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = COVER_WIDTH; canvas.height = COVER_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('这台机器上无法绘制封面。');
  if (uploaded) {
    const image = await new Promise<HTMLImageElement>((done, fail) => {
      const element = new Image();
      element.onload = () => done(element);
      element.onerror = () => fail(new Error('封面图片读不出来。'));
      element.src = uploaded;
    });
    const scale = Math.max(COVER_WIDTH / image.width, COVER_HEIGHT / image.height);
    const width = image.width * scale; const height = image.height * scale;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, (COVER_WIDTH - width) / 2, (COVER_HEIGHT - height) / 2, width, height);
  } else {
    drawCover(context, input);
  }
  return canvas.toDataURL('image/png');
}
