const SVG_NS = 'http://www.w3.org/2000/svg';

/** A soft five-pointed star, filled with `currentColor`. */
export function starIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('star-icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    'M12 2.8c.4 0 .8.2 1 .6l2.3 4.7 5.2.8c.9.1 1.2 1.2.6 1.8l-3.8 3.7.9 5.2c.2.9-.8 1.5-1.6 1.1L12 18.3l-4.6 2.4c-.8.4-1.8-.2-1.6-1.1l.9-5.2-3.8-3.7c-.6-.6-.3-1.7.6-1.8l5.2-.8L11 3.4c.2-.4.6-.6 1-.6z',
  );
  svg.append(path);
  return svg;
}

function strokeIcon(className: string, paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('line-icon', className);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Back: a chevron pointing left. */
export function backIcon(): SVGSVGElement {
  return strokeIcon('back-icon', ['M14.5 5.5 8 12l6.5 6.5']);
}

/** Settings: three sliders at different settings. */
export function settingsIcon(): SVGSVGElement {
  return strokeIcon('settings-icon', [
    'M4 7h16M4 12h16M4 17h16',
    'M9 5.2v3.6M15 10.2v3.6M7 15.2v3.6',
  ]);
}

/** Credits: an eighth note. */
export function noteIcon(): SVGSVGElement {
  const svg = strokeIcon('note-icon', ['M14 17.5V4.5c1.4 2.6 4.6 3.1 4.6 6.4']);
  const head = document.createElementNS(SVG_NS, 'ellipse');
  head.setAttribute('cx', '11.2');
  head.setAttribute('cy', '17.6');
  head.setAttribute('rx', '3');
  head.setAttribute('ry', '2.4');
  head.setAttribute('transform', 'rotate(-20 11.2 17.6)');
  head.classList.add('note-head');
  svg.append(head);
  return svg;
}

/** Rhythm: a tile landing on the line. */
export function rhythmIcon(): SVGSVGElement {
  return strokeIcon('rhythm-icon', [
    'M9 3.5h6a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 12V5A1.5 1.5 0 0 1 9 3.5z',
    'M3.5 18h17',
  ]);
}

/** Tiles: a short tile and a long one, in two columns. */
export function tilesIcon(): SVGSVGElement {
  return strokeIcon('tiles-icon', [
    'M5.5 3.5h3a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 4 9V5a1.5 1.5 0 0 1 1.5-1.5z',
    'M15.5 8.5h3A1.5 1.5 0 0 1 20 10v9a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 14 19v-9a1.5 1.5 0 0 1 1.5-1.5z',
  ]);
}

/** Change game: two arrows swapping places. */
export function swapIcon(): SVGSVGElement {
  return strokeIcon('swap-icon', ['M4.5 8h14l-3.5-3.5', 'M19.5 16h-14l3.5 3.5']);
}

/** How to play: a question mark in a circle. */
export function helpIcon(): SVGSVGElement {
  return strokeIcon('help-icon', [
    'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z',
    'M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4',
    'M12 16.8v.2',
  ]);
}
