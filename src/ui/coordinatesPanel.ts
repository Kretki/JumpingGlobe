/** Top-left read-out of the look-at point, camera and land status (text nodes only, no innerHTML). */

export type CoordinatesReadout = {
  latitudeDeg: number;
  longitudeDeg: number;
  surfaceEcef: number[];
  cameraHeightM: number;
  lodFileName: string;
  ageInMyr: number;
  landStatus: string;
};

const LINE_COUNT = 6;

export class CoordinatesPanel {
  private readonly lineElements: HTMLDivElement[] = [];
  private readonly renderedText: string[] = [];

  /**
   * Build the panel's fixed structure once.
   *
   * Usage: once at start-up.
   *
   * @param panelElement - The #coords container (its content is replaced).
   */
  constructor(panelElement: HTMLElement) {
    const titleLine = document.createElement("div");
    const titleText = document.createElement("b");
    titleText.textContent = "Look-at (WGS84 / EPSG:4326)";
    titleLine.append(titleText);
    panelElement.replaceChildren(titleLine);
    for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
      const lineElement = document.createElement("div");
      panelElement.append(lineElement);
      this.lineElements.push(lineElement);
      this.renderedText.push("");
    }
  }

  /**
   * Update the read-out (only lines whose text changed touch the DOM).
   *
   * Usage: once per frame. Server-provided strings (file names, status) are set
   * via textContent, so they can never inject markup.
   *
   * @param readoutValues - Values to show.
   * @returns Nothing.
   */
  updateReadout(readoutValues: CoordinatesReadout): void {
    const surfaceEcef = readoutValues.surfaceEcef;
    const lineTexts = [
      `lat ${readoutValues.latitudeDeg.toFixed(6)}° · lon ${readoutValues.longitudeDeg.toFixed(6)}°`,
      `ECEF ${surfaceEcef[0].toFixed(1)}, ${surfaceEcef[1].toFixed(1)}, ${surfaceEcef[2].toFixed(1)} m`,
      `camera height ${readoutValues.cameraHeightM.toFixed(1)} m`,
      `lod ${readoutValues.lodFileName}`,
      `age ${readoutValues.ageInMyr.toFixed(0)} Ma`,
      `land ${readoutValues.landStatus}`,
    ];
    lineTexts.forEach((lineText, lineIndex) => {
      if (this.renderedText[lineIndex] === lineText) return;
      this.renderedText[lineIndex] = lineText;
      this.lineElements[lineIndex].textContent = lineText;
    });
  }
}
