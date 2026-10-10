/**
 * X12 tokenizer. Delimiters are not fixed: the ISA segment declares them. The element
 * separator is the character right after "ISA", the component separator is ISA16, and the
 * segment terminator is the character right after ISA16.
 */

export interface Delimiters {
  element: string;
  component: string;
  segment: string;
  repetition?: string;
}

export interface Segment {
  id: string;
  /** elements[0] is the segment id, so elements[n] is the n-th data element (1-based like X12). */
  elements: string[];
  /** 1-based position in the file, for error messages. */
  position: number;
}

export class X12ParseError extends Error {
  override name = 'X12ParseError';
  constructor(
    message: string,
    readonly position?: number,
  ) {
    super(message);
  }
}

const ISA_ELEMENT_COUNT = 16;

export function readDelimiters(text: string): Delimiters {
  if (!text.startsWith('ISA')) {
    throw new X12ParseError('An 835 file must start with an ISA segment.');
  }
  const element = text[3];
  if (!element || /[\w\s]/.test(element)) {
    throw new X12ParseError('Could not read the element separator from the ISA segment.');
  }
  // Walk to the 16th element separator; ISA16 follows it, then the segment terminator.
  let index = 3;
  for (let seen = 1; seen < ISA_ELEMENT_COUNT; seen++) {
    index = text.indexOf(element, index + 1);
    if (index === -1) throw new X12ParseError('The ISA segment is truncated.');
  }
  const component = text[index + 1];
  const segment = text[index + 2];
  if (!component || !segment) throw new X12ParseError('The ISA segment is truncated.');

  const isaElements = text.slice(0, index + 2).split(element);
  const repetition = isaElements[11];
  return {
    element,
    component,
    segment,
    ...(repetition && repetition.length === 1 && repetition !== 'U' ? { repetition } : {}),
  };
}

export function tokenize(raw: string): { delimiters: Delimiters; segments: Segment[] } {
  const text = raw.replace(/^\uFEFF/, '').replace(/^\s+/, '');
  const delimiters = readDelimiters(text);
  const segments: Segment[] = [];
  for (const chunk of text.split(delimiters.segment)) {
    const trimmed = chunk.replace(/^[\r\n]+|[\r\n]+$/g, '');
    if (trimmed.trim() === '') continue;
    // ISA elements are space-padded to fixed widths; trimming makes them comparable.
    const elements = trimmed.split(delimiters.element).map((e) => e.trim());
    segments.push({ id: elements[0] ?? '', elements, position: segments.length + 1 });
  }
  return { delimiters, segments };
}
