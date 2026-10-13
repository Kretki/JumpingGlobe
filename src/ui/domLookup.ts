/** Typed, fail-fast DOM lookups. */

/**
 * Find an element by id and check its type.
 *
 * Usage: ``requireElement("tl-age", HTMLInputElement)`` at start-up, instead of unchecked casts.
 *
 * @param elementId - Element id in index.html.
 * @param elementType - Expected element class.
 * @returns The element.
 * @throws Error when the element is missing or has another type.
 */
export function requireElement<ElementType extends Element>(
  elementId: string,
  elementType: new (...constructorArgs: never[]) => ElementType
): ElementType {
  const foundElement = document.getElementById(elementId);
  if (!(foundElement instanceof elementType)) {
    throw new Error(`#${elementId} is missing or not a ${elementType.name}`);
  }
  return foundElement;
}
