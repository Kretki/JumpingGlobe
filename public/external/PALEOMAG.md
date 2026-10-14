# True polar wander and paleomagnetic poles

The "Paleomagnetism" group of the layers panel draws data from two folders under
`public/external/`:
- `tpw/` holds the TPW data (Vaes et al. 2023 GAPWAP supplement, plus Torsvik et al.
  2014 rates).
- `paleomagnetic_poles/` holds the paleomagnetic poles.

The server reads the files directly; no prep script is needed. They are configured in
the `paleoMagnetics` section of `lod.json` and served as one JSON document by
`GET /api/paleomag`. Sources are listed in `ARTICLES.md`.

| Layer | Data | Shown when |
|-------|------|------------|
| TPW poles (rods, path, 95 % circle) | `tpw/input_APWP.xlsx`, sheet `TPWPs` | the age lies on the chosen path: M22 covers 0–320 Ma; D12, T08, M93 and the published D12 TPW path cover 0–120 Ma |
| TPW latitude / longitude grid | same | same |
| Magnetic poles | `paleomagnetic_poles/*.csv` | the age lies in a pole's age window |
| Magnetic field lines (1–3 layers) | same | same |

A checkbox whose data does not cover the displayed age is greyed out but keeps its
state. The "Path" dropdown chooses the mantle reference frame of the TPW path.

## Files the program uses

| File | Purpose |
|------|---------|
| `tpw/input_APWP.xlsx`, sheet `TPWPs` | TPW paths: spin-axis pole (lon, lat) every 10 Myr in five mantle reference frames, with the 95 % confidence radius `P95`. |
| `tpw/input_APWP.xlsx`, sheet `V23_int` | Polar-wander rate with its lower and upper bound, every 10 Myr (note under the TPW checkboxes). |
| `tpw/rates_T14.csv` | Torsvik et al. 2014 TPW rate and net TPW angle, 0–320 Ma (same note). |
| `paleomagnetic_poles/south_china_phanerozoic_poles.csv` | South China poles, Cenozoic to Cambrian (dated by period names). |
| `paleomagnetic_poles/south_china_neoproterozoic_poles.csv` | South China poles, 832–560 Ma. |
| `paleomagnetic_poles/rodinia_850_810_poles.csv` | East Svalbard, Baltica and West Africa poles, ~860–810 Ma. |

## Files the program does not use

| File | Why |
|------|-----|
| `tpw/GAPWAP_plate_circuit_{D12,M22,M93,T08}.rot` | Relative plate circuits (Africa fixed) that the GAPWAP and the TPW paths were computed with. The paths are already in the workbook, and the globe positions plates with the Cao model. |
| `tpw/input_APWP.xlsx`, sheets `V23`, `V23_int_5`, `PWPs` | The global APWP (south poles in African coordinates) at the raw, 10 Myr and 5 Myr steps, and the polar-wander paths of each frame. Only the TPW paths and the 10 Myr rates are drawn. |
| `paleomagnetic_poles/fanjingshan_sites_vgps.csv` | Site-level VGPs; their mean is the FJS pole already listed in `south_china_neoproterozoic_poles.csv`. |

## How the data is placed on the globe

- **TPW poles.** The path poles give where the spin axis was relative to the mantle.
  They are drawn in mantle-frame coordinates, which the globe shows as its own
  longitude/latitude grid (the mantle frame and present-day geography coincide at
  0 Ma).
  - Between the 10 Myr steps the pole moves along the great circle, and `P95` is
    interpolated linearly.
  - Grey rods leave both spin poles. The whole path of the chosen frame is drawn on
    the ground in both hemispheres, with the 95 % circle around the current pole.
  - The continents are drawn in Cao's paleomagnetic frame. The rods therefore show the
    TPW pole relative to the mantle, not the spin axis relative to the reconstructed
    continents (in Cao's frame that axis is always the globe's own axis).
- **TPW grid.** The grid is turned so that its north pole is the TPW pole, using the
  smallest rotation from the present-day pole. It shows:
  - the equator;
  - the tropics and polar circles at the present obliquity (23.44°);
  - the 60°, 90°, 120° and 150° meridians, east and west;
  - ticks every 10°, with labels every 30°.

  From far away the grid floats at `gridLiftFraction` × Earth radius above the
  ground. It settles on the ground below `gridGroundHeightM`.
- **Rate note.** The note shows:
  - the polar-wander rate from `V23_int`, with its bounds;
  - the Torsvik et al. 2014 rate and net TPW angle.

  All three values are interpolated linearly between samples; empty cells are skipped.
- **Plates of paleomagnetic poles.** `paleoMagnetics.blockPlateIds` maps the block names
  of the pole tables to Cao plate ids: South China 602, Laurentia 101, Baltica 302,
  East Svalbard 311 and West Africa 714. Poles move with their block's plate at the
  displayed age.
- **Magnetic poles.** The tabulated pole is drawn as the north pole (red), and its
  antipode as the south pole (blue). Each pole's 95 % confidence circle is drawn too;
  for a dp/dm ellipse, the larger axis is used.
- **Field lines.** The lines are drawn as the field of a bar magnet whose axis is the
  mean of the poles shown at that age. The magnet is a north and a south magnetic
  charge, 0.85 Earth radii from the centre (`magnetProfile.ts`).
  - The lines leave the ground in tubes around the poles; the tube mouths are
    outlined on the ground.
  - Each layer holds 24 lines, and the layers reach out to 1.6, 2.4 and 3.4 Earth
    radii.
  - The lines shade from red to blue and carry an arrow at their apex (north → south).

## Adding TPW paths

To add a path from the same workbook layout, add an entry to
`paleoMagnetics.tpwWorkbook.frames`:

```json
{ "key": "X", "label": "...", "lonColumn": "lon_X", "latColumn": "lat_X" }
```

The first entry is the dropdown's default. Sheet and column names (`pathSheet`,
`ageColumn`, `confidenceColumn`, `rateSheet`, `rateColumn`, ...) are configurable too.

## Ages of paleomagnetic poles

- Ranges (`~820–810`, `~590 to 560`), uncertainties (`799.5 ± 8.4`) and combined
  determinations (`848 ± 27/834 ± 9`, `857.2 ± 8.5 & 855 ± 16`) become one age window
  covering all of them.
- Period names (`Late Cretaceous`, `Cambrian - Series 2`, ...) are looked up in
  `paleoMagnetics.namedAgesMa`. Those ages follow the ICS chart; edit the table to use
  other boundaries.
- Windows narrower than `minAgeWindowMyr` (2 Myr) are widened around their middle, so
  that poles dated to ±0.2 Myr still show on the 1 Myr timeline.
