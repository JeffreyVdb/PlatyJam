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
