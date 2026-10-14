# True polar wander and paleomagnetic poles

The "Paleomagnetism" group of the layers panel draws data from two folders under
`public/external/`:
- `tpw/` holds the TPW data (Vaes et al. 2023 GAPWAP supplement, plus Torsvik et al.
  2014 rates).
- `paleomagnetic_poles/PINTv820.csv` is the PINT paleointensity database (v8.2). It is
  the only source of the magnetic layers.

The server reads the files directly (the CSVs with polars); no prep script is needed. They are configured in
the `paleoMagnetics` section of `lod.json` and served as one JSON document by
`GET /api/paleomag`. Sources are listed in `ARTICLES.md`.

| Layer | Data | Shown when |
|-------|------|------------|
| TPW poles (rods, path, 95 % circle) | `tpw/input_APWP.xlsx`, sheet `TPWPs` | the age lies on the chosen path: M22 covers 0–320 Ma; D12, T08, M93 and the published D12 TPW path cover 0–120 Ma |
| TPW latitude / longitude grid | same | same |
| Magnetic poles (poles, their strength and scatter, site VGPs) | `paleomagnetic_poles/PINTv820.csv` | a PINT site with a field direction lies within ≈ 2.5 σ of the age |
| Magnetic field lines (1–3 layers) | same | same |
| Field-strength chart | same | always (all sites with a dipole moment, marker at the displayed age) |

A checkbox whose data does not cover the displayed age is greyed out but keeps its
state. The "Path" dropdown chooses the mantle reference frame of the TPW path.

## Files the program uses

| File | Purpose |
|------|---------|
| `tpw/input_APWP.xlsx`, sheet `TPWPs` | TPW paths: spin-axis pole (lon, lat) every 10 Myr in five mantle reference frames, with the 95 % confidence radius `P95`. |
| `tpw/input_APWP.xlsx`, sheet `V23_int` | Polar-wander rate with its lower and upper bound, every 10 Myr (note under the TPW checkboxes). |
| `tpw/rates_T14.csv` | Torsvik et al. 2014 TPW rate and net TPW angle, 0–320 Ma (same note). |
| `paleomagnetic_poles/PINTv820.csv` | Site location, age ± error, polarity, field direction (INC, DEC) and dipole moment (VDM / VADM). |

## Files the program does not use

| File | Why |
|------|-----|
| `tpw/GAPWAP_plate_circuit_{D12,M22,M93,T08}.rot` | Relative plate circuits (Africa fixed) that the GAPWAP and the TPW paths were computed with. The paths are already in the workbook, and the globe positions plates with the Cao model. |
| `tpw/input_APWP.xlsx`, sheets `V23`, `V23_int_5`, `PWPs` | The global APWP (south poles in African coordinates) at the raw, 10 Myr and 5 Myr steps, and the polar-wander paths of each frame. Only the TPW paths and the 10 Myr rates are drawn. |
| `paleomagnetic_poles/fanjingshan_sites_vgps.csv`, `rodinia_850_810_poles.csv`, `south_china_neoproterozoic_poles.csv`, `south_china_phanerozoic_poles.csv` | Earlier pole tables; the magnetic layers now use PINT only. They can be deleted. |

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
- **Magnetic field.** Everything comes from PINT, in four steps (settings in
  `lod.json` `paleoMagnetics.pintSites`).
  1. *Sites → VGPs.* Each site's field direction gives its virtual geomagnetic pole
     (VGP), computed on the server with polars. 3194 of the 4680 usable sites have a
     direction.
     - The server assigns every site to the Cao plate under it, using the static
       polygons and preferring the polygon that existed at the site's age.
     - The browser moves the VGP with that plate to the displayed age.
  2. *Age window.* A site counts at the displayed age by a Gaussian of its age
     difference, with σ = its age error, kept within `minWindowMyr`..`maxWindowMyr`.
     - Sites further than about 2.5 σ are left out.
     - The weight is divided by σ, so loosely dated sites count less.
     - Within a window, VGPs of different polarity appear together. That is how
       reversals and excursions show.
  3. *Poles.* The weighted VGPs are grouped: sites within `clusterRadiusDeg` (30°) of a
     group's mean join it, and groups whose means come that close are merged.
     - Groups holding at least `minPoleShare` of the weight are poles. A stable field
       gives one pole; reversals and excursions give two or more, for example a normal,
       a reversed and an equatorial pole around 2.6 Ma.
     - A pole's strength is the weighted mean dipole moment of its sites, in 10²² A·m².
       When none of its sites has a moment, the window mean is used (labelled "est.").
     - Each pole is drawn as a ring at its north end (red) and its antipode (blue),
       sized by its moment. A fainter circle shows the scatter of its VGPs, and every
       site VGP is a small cross coloured by polarity (N red, R blue, T yellow).
  4. *Field lines.* Every pole with at least `minSourceShare` of the weight (at most
     `maxFieldSources`) becomes a buried bar magnet. This is a negative magnetic charge
     under its north pole and a positive one under its south pole, `magnetDepth` (0.85)
     Earth radii from the centre, sized by share × moment.
     - The field is the sum over all charges, so several poles give a multipolar field.
     - Lines start in tubes of 30°, 18° and 12° (layers 1–3) around each positive
       charge. Each layer has 24 lines, shared out by source strength.
     - Lines are traced in 3D (Runge–Kutta) until they reach the ground again, or
       5 Earth radii. They are drawn from blue (field leaving, geomagnetic south) to red
       (field entering, geomagnetic north), with the arrow pointing along the field, as
       in today's field.
  - The chart under the checkboxes plots every site's moment against age (log scale)
    with a running median. Its marker shows the displayed age and the window's mean
    moment.

## Adding TPW paths

To add a path from the same workbook layout, add an entry to
`paleoMagnetics.tpwWorkbook.frames`:

```json
{ "key": "X", "label": "...", "lonColumn": "lon_X", "latColumn": "lat_X" }
```

The first entry is the dropdown's default. Sheet and column names (`pathSheet`,
`ageColumn`, `confidenceColumn`, `rateSheet`, `rateColumn`, ...) are configurable too.
