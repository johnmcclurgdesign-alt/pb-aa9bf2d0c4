# ART2 (#75, #153) — the floor lamp, built from nothing. ORIGINAL GEOMETRY.
# Run INSIDE Blender, headless is the method:
#   blender -b <production>.blend -P tools/blender-build-floor-lamp.py            (build + save)
#   DP_LAMP_NOSAVE=1 blender -b <production>.blend -P tools/blender-build-floor-lamp.py   (dry run)
# then tools/blender-seat-props.py (it seats the lamp on the floor), then
# tools/blender-export-lamp.py (it writes assets/dripping-pickle/props_lamp.glb).
#
# ★ THIS SCRIPT IS THE AUTHORSHIP RECORD. `asset-provenance.csv` names it as the source of
#   `Prop_Floor_Lamp` and the licence is `original`; there is no upstream file to point at, so
#   if this script is lost the provenance claim is lost with it. Same contract as
#   tools/blender-build-radio.py and tools/blender-build-mouse.py.
#
# WHAT IT REPLACES. `Prop_Vintage_Floor_Lamp` (scene root of Scene_60, 45,522 vertices, nine
# materials with German names, procedural Noise/Voronoi shading, zero image textures) shipped
# from 2026-08-19 in its own glb with NO provenance row: nobody could say where it came from
# (#75; the blend carries no `asset_data`, no library link, no image path — docs/lessons/
# provenance-cannot-be-read-off-a-procedural-asset). John was asked and did not answer by
# 2026-10-06, so Josh took PROGRAM decision 2's fallback: build an original in its place.
# The old object STAYS in the blend, hidden from render — retired from the export, never
# deleted (the prompt's rule, and the blend's README: John's file, edited in place).
#
# THE BRIEF IS THE PICTURE JOSH SIGNED, NOT THE OLD MESH. Measured from the loop camera (#75,
# 2026-09-07): only the top ~24 cm is unoccluded, poking above the toolbox — a dark red dome
# about 25 px across at 1280×720, a grey gooseneck, and a warm white band under the rim where
# the shade's inside catches the lamp's own light. So the design is the same KIND of lamp, a
# 1970s lacquered dome on a gooseneck, drawn fresh in a handful of lathes and one sweep, and
# it has to land in the same place at the same size. Everything below 1.0 m is behind crates
# and the toolbox and is modelled only so the lamp is a whole object (shadow, GI, a reviewer
# who flies the camera round).
#
# EVERY NUMBER BELOW IS A MEASUREMENT OF THE OLD LAMP, in Blender world metres (Z up), read
# headless from the production blend on 2026-10-06 — per material, per height band:
#   origin            (0.40963, 1.90289, 0.02110), rotation 0, scale 1   ← kept EXACTLY
#   overall bbox      x 0.1305..0.5111  y 1.7949..2.0814  z 0.0078..1.1711
#   base disc         centre (0.3961, 1.9099), r 0.115, z 0.0078..0.0264
#   pole              axis (0.3966, 1.9097), r 0.015, to z 0.972; a joint ring at z 0.722
#   collar            r 0.020, z 0.972..1.000
#   gooseneck         horizontal at z ~1.075 between x 0.24 and 0.38
#   dome              top z 1.1711, lowest rim z 1.0345, ~0.14 across, opening tilted ~10°
#                     away from the pole (the glass's fitted normal −0.168, 0.053, −0.984)
#   glass             bbox x 0.1726..0.2521  y 1.9762..2.0419  z 1.0492..1.1096
#
# ★ THE GLASS BBOX CENTRE IS LOAD-BEARING. `lightLamp()` in loops/dripping-pickle/index.html
#   finds the mesh whose material is named `glas` and plants the lamp's PointLight at that
#   mesh's bounding-box centre. The bulb below is sized and placed so its bbox centre is the
#   old glass's, to the millimetre — so the light that warms that corner of the room does not
#   move, and the GI volume (baked with the old lamp in place) still describes this room.
#   The material keeps the name `glas` for the same reason; the old lamp's own `glas` is
#   renamed `glas_vintage` so the new one can have the name (Blender names are unique, and a
#   `glas.001` would export as `glas.001` and silently unbind the light).
#
# MATERIALS: FOUR, AGAINST THE OLD LAMP'S EIGHT EXPORTED PRIMITIVES. A primitive is a draw on
# a lit frame, and the phone's fixed cost is lit draws (PROGRAM decision 16). Principled BSDF
# and nothing else, rebuilt from scratch, so nothing is dropped on the glTF trip.
#   Lamp_Lacquer_Red  the body. Its factors are the old body's EXPORTED values, because that
#                     is the red in the picture Josh signed — and that includes ROUGHNESS 1.0:
#                     the old material's roughness was driven by its procedural graph, so the
#                     exporter wrote no roughnessFactor and three used the glTF default, 1.0.
#                     The Blender-side 0.29 shipped a glossy dome with a hot highlight in the
#                     first A/B (2026-10-06); the picture is the brief, not the .blend.
#   Lamp_Black        the gooseneck, collar, ferrules, rim lip and switch: black, roughness 1,
#                     not metal — the old dark parts' exported values. NOT the radio's
#                     Equipment_Dark: its 0.65 roughness and 0.25 metal lit the corrugation into
#                     a light grey stripe in the same A/B, and this glb merges with nothing
#                     else anyway, so sharing bought no draw.
#   Lamp_Reflector    the inside of the shade — the white band under the rim, dimmed until it
#                     reads as the old one did (a full white was twice as wide and bright).
#   glas              the bulb. Opaque white, roughness 0.1: what the old glass exported once
#                     its transmission was zeroed at load (BUD2), so the look is unchanged and
#                     the zeroing never has to touch this one.
# No textures at all: this prop adds ZERO resident texture bytes.
import bpy, bmesh, os, math
from mathutils import Vector, Matrix

NAME = "Prop_Floor_Lamp"
OLD  = "Prop_Vintage_Floor_Lamp"
COLL = "Props_Lamp"      # its own collection: never the scene root (the lamp trap), never
                         # `Props` (blender-export-props.py would ship it a second time in props.glb)

ORIGIN = Vector((0.4096251130104065, 1.9028871059417725, 0.021102668717503548))
POLE   = Vector((0.3966, 1.9097, 0.0))       # pole and base axis (xy)
GROUND = 0.0078                              # the old base's underside; the seat script owns the final z

SEG = 32                                     # round things: ~2 px a facet at the room pose


def _log(*a):
    print("[build-floor-lamp]", *a)


def mat(name, base, rough, metal):
    """A Principled BSDF and an Output, and NOTHING ELSE (see tools/blender-build-radio.py)."""
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs['BSDF'], out.inputs['Surface'])
    b.inputs['Base Color'].default_value = (*base, 1.0)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    for k in ('Transmission Weight', 'Transmission'):
        if k in b.inputs:
            b.inputs[k].default_value = 0.0
    if 'Emission Strength' in b.inputs:
        b.inputs['Emission Strength'].default_value = 0.0   # the LOOP owns the glow (lightLamp)
    m.use_backface_culling = False                        # → glTF doubleSided: the shade is open
    return m


# ── geometry helpers: everything is a lathe or a sweep, in WORLD space ───────────────────────
def frame(axis):
    """Two unit vectors perpendicular to `axis`, so a ring can be drawn round any axis."""
    a = axis.normalized()
    t = Vector((1, 0, 0)) if abs(a.x) < 0.9 else Vector((0, 1, 0))
    u = a.cross(t).normalized()
    v = a.cross(u).normalized()
    return a, u, v


def lathe(bm, centre, axis, profile, mi, cap_bottom=False, cap_top=False):
    """Revolve [(r, h)] about `axis` through `centre`; h is measured ALONG the axis."""
    a, u, v = frame(axis)
    rings = []
    for (r, h) in profile:
        ring = []
        for i in range(SEG):
            t = 2 * math.pi * i / SEG
            p = centre + a * h + (u * math.cos(t) + v * math.sin(t)) * r
            ring.append(bm.verts.new(p))
        rings.append(ring)
    for k in range(len(rings) - 1):
        A, B = rings[k], rings[k + 1]
        for i in range(SEG):
            j = (i + 1) % SEG
            f = bm.faces.new((A[i], A[j], B[j], B[i]))
            f.material_index = mi
    if cap_bottom:
        bm.faces.new(list(reversed(rings[0]))).material_index = mi
    if cap_top:
        bm.faces.new(rings[-1]).material_index = mi
    return rings


def sweep(bm, path, radius_at, mi, seg=12):
    """A tube along a polyline, its radius a function of arc length — the corrugated neck."""
    rings, s = [], 0.0
    prev_u = None
    for k, p in enumerate(path):
        if k:
            s += (p - path[k - 1]).length
        t = (path[min(k + 1, len(path) - 1)] - path[max(k - 1, 0)]).normalized()
        # parallel transport, so the tube does not twist round the bend
        if prev_u is None:
            _, prev_u, _ = frame(t)
        u = (prev_u - t * prev_u.dot(t)).normalized()
        v = t.cross(u).normalized()
        prev_u = u
        r = radius_at(s)
        rings.append([bm.verts.new(p + (u * math.cos(2 * math.pi * i / seg) +
                                        v * math.sin(2 * math.pi * i / seg)) * r)
                      for i in range(seg)])
    for k in range(len(rings) - 1):
        A, B = rings[k], rings[k + 1]
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((A[i], A[j], B[j], B[i])).material_index = mi
    bm.faces.new(list(reversed(rings[0]))).material_index = mi
    bm.faces.new(rings[-1]).material_index = mi


def run():
    sc = bpy.data.scenes["Scene_60"]
    old = bpy.data.objects.get(OLD)
    assert old is not None, "the old lamp is gone from the blend — it is retired, never deleted"

    # ── 0. free the name `glas` for the new bulb, without touching the old lamp's look ───────
    oldglas = bpy.data.materials.get("glas")
    if oldglas is not None and oldglas.users and any(
            s.material == oldglas for s in old.material_slots):
        oldglas.name = "glas_vintage"
    assert "glas" not in bpy.data.materials or not any(
        s.material and s.material.name == "glas" for s in old.material_slots)

    red   = mat("Lamp_Lacquer_Red", (0.16574, 0.017905, 0.0065775), 1.0, 0.31)
    dark  = mat("Lamp_Black",       (0.0, 0.0, 0.0), 1.0, 0.0)
    refl  = mat("Lamp_Reflector",   (0.50, 0.49, 0.47), 1.0, 0.0)
    glass = mat("glas",             (1.0, 1.0, 1.0), 0.10, 0.0)
    assert glass.name == "glas", "the bulb's material must be exactly 'glas' (lightLamp binds by name)"
    MATS = [red, dark, refl, glass]
    RED, DARK, REFL, GLAS = range(4)

    bm = bmesh.new()
    up = Vector((0, 0, 1))
    P = Vector((POLE.x, POLE.y, GROUND))

    # ── 1. the base: a low lacquered disc with a rolled edge ─────────────────────────────────
    lathe(bm, P, up, [(0.112, 0.0), (0.115, 0.0025), (0.115, 0.0070),
                      (0.111, 0.0100), (0.060, 0.0160), (0.022, 0.0186)], RED,
          cap_bottom=True, cap_top=True)
    # a dark ferrule where the pole meets the base
    lathe(bm, P, up, [(0.019, 0.0170), (0.019, 0.0300), (0.0165, 0.0330)], DARK, cap_top=True)

    # ── 2. the pole, in two lengths with a dark joint ring, and a switch ─────────────────────
    lathe(bm, P, up, [(0.015, 0.0300), (0.015, 0.7140)], RED)
    lathe(bm, P, up, [(0.0150, 0.7140), (0.0162, 0.7160), (0.0162, 0.7280), (0.0150, 0.7300)], DARK)
    lathe(bm, P, up, [(0.015, 0.7300), (0.015, 0.9640)], RED)
    sw_dir = Vector((-0.32, -0.95, 0.0)).normalized()        # where the old one's switch faced
    sw = P + up * (0.7790 - GROUND) + sw_dir * 0.0145
    lathe(bm, sw, sw_dir, [(0.0055, 0.0), (0.0055, 0.0060), (0.0040, 0.0085)], DARK, cap_top=True)

    # ── 3. the collar the gooseneck screws into ──────────────────────────────────────────────
    lathe(bm, P, up, [(0.0150, 0.9600), (0.0200, 0.9660), (0.0200, 0.9920), (0.0150, 0.9960)],
          DARK, cap_top=True)

    # ── 4. the gooseneck: up, a 90° bend, then level into the side of the shade ──────────────
    # Direction from the pole to the shade, measured: (−0.181, +0.094) → 0.204 m away.
    D = Vector((-0.8868, 0.4620, 0.0)).normalized()
    R_BEND, Z0, Z_LEVEL = 0.058, 0.9900, 1.0750
    start = Vector((POLE.x, POLE.y, Z0))
    z_bend = Z_LEVEL - R_BEND
    path = [start, Vector((POLE.x, POLE.y, z_bend))]
    for i in range(1, 25):
        t = (math.pi / 2) * i / 24
        path.append(Vector((POLE.x, POLE.y, z_bend)) + D * (R_BEND * (1 - math.cos(t)))
                    + up * (R_BEND * math.sin(t)))
    reach = 0.150                                           # ends ~2 cm inside the shade wall
    n_straight = 24
    for i in range(1, n_straight + 1):
        path.append(Vector((POLE.x, POLE.y, Z_LEVEL)) + D * (R_BEND + (reach - R_BEND) * i / n_straight))
    # resample evenly so the corrugation reads as rings, not as facets
    even, acc = [path[0]], 0.0
    STEP = 0.0030
    for a, b in zip(path, path[1:]):
        L = (b - a).length
        while acc + L >= STEP:
            f = (STEP - acc) / L
            a = a + (b - a) * f
            L = (b - a).length
            even.append(a)
            acc = 0.0
        acc += L
    even.append(path[-1])
    sweep(bm, even, lambda s: 0.0128 + 0.0022 * (0.5 + 0.5 * math.cos(2 * math.pi * s / 0.0065)), DARK)

    # ── 5. the shade: a dome on a short skirt, its opening tilted ~10° away from the pole ────
    U = Vector((0.168, -0.053, 0.984)).normalized()         # the old glass's normal, reversed
    R_DOME, SKIRT, WALL = 0.0710, 0.0555, 0.0022
    rim = Vector((0.2068, 2.0067, 1.0470))                  # solved from the old dome's top and lowest rim
    outer = [(R_DOME, 0.0), (R_DOME, SKIRT)]
    inner = [(R_DOME - WALL, 0.0015), (R_DOME - WALL, SKIRT)]
    # stop one step short of the pole and cap it: a ring of radius 0 is 32 coincident
    # vertices, and the quads into it are degenerate
    for i in range(1, 12):
        t = (math.pi / 2) * i / 12
        outer.append((R_DOME * math.cos(t), SKIRT + R_DOME * math.sin(t)))
        inner.append(((R_DOME - WALL) * math.cos(t), SKIRT + (R_DOME - WALL) * math.sin(t)))
    lathe(bm, rim, U, outer, RED, cap_top=True)
    lathe(bm, rim, U, inner, REFL, cap_top=True)
    # flip the inner shell so it faces INTO the shade, where the light is
    for f in bm.faces:
        if f.material_index == REFL:
            f.normal_flip()
    # the rolled lip that closes the wall, in the shared dark
    lathe(bm, rim, U, [(R_DOME + 0.0012, 0.0045), (R_DOME + 0.0012, -0.0005),
                       (R_DOME - WALL - 0.0008, -0.0005), (R_DOME - WALL - 0.0008, 0.0030)], DARK)
    # the socket boss on the shade's side, where the neck goes in
    boss_at = Vector((POLE.x, POLE.y, Z_LEVEL)) + D * 0.128
    lathe(bm, boss_at, D, [(0.0165, -0.006), (0.0165, 0.010), (0.0130, 0.014)], DARK,
          cap_bottom=True)

    # ── 6. the bulb: a frosted globe whose bbox centre IS the old glass's (see header) ───────
    G = Vector(((0.1726 + 0.2521) / 2, (1.9762 + 2.0419) / 2, (1.0492 + 1.1096) / 2))
    rx, ry, rz = (0.2521 - 0.1726) / 2, (2.0419 - 1.9762) / 2, (1.1096 - 1.0492) / 2
    # poles capped rather than collapsed, as the shade's top is; the latitude rings stop at
    # ±82.5° and the extreme z is restored by scaling, so the bbox is still the old glass's
    lat = [math.pi * k / 12 - math.pi / 2 for k in range(1, 12)]
    zs = 1.0 / math.sin(lat[-1])
    rings = []
    for (c, s_) in [(math.cos(ph), math.sin(ph) * zs) for ph in lat]:
        ring = []
        for i in range(SEG):
            t = 2 * math.pi * i / SEG
            ring.append(bm.verts.new(G + Vector((rx * c * math.cos(t), ry * c * math.sin(t), rz * s_))))
        rings.append(ring)
    for k in range(len(rings) - 1):
        for i in range(SEG):
            j = (i + 1) % SEG
            bm.faces.new((rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i])).material_index = GLAS
    bm.faces.new(list(reversed(rings[0]))).material_index = GLAS
    bm.faces.new(rings[-1]).material_index = GLAS

    # ── 7. one object, at the OLD ORIGIN, rotation 0, scale 1 ────────────────────────────────
    bm.transform(Matrix.Translation(-ORIGIN))
    old_obj = bpy.data.objects.get(NAME)
    if old_obj is not None:
        bpy.data.objects.remove(old_obj, do_unlink=True)
    me_old = bpy.data.meshes.get(NAME)
    if me_old is not None and me_old.users == 0:
        bpy.data.meshes.remove(me_old)
    me = bpy.data.meshes.new(NAME)
    bm.to_mesh(me)
    bm.free()
    for m in MATS:
        me.materials.append(m)
    me.validate()
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(40))       # the disc edge and the collar stay crisp
    o = bpy.data.objects.new(NAME, me)
    o.location = ORIGIN
    coll = bpy.data.collections.get(COLL)
    if coll is None:
        coll = bpy.data.collections.new(COLL)
        sc.collection.children.link(coll)
    coll.objects.link(o)

    # ── 8. retire the old lamp: out of the render and the export, still in the blend ─────────
    old.hide_render = True
    old.hide_viewport = True

    bpy.context.view_layer.update()
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    M = o.matrix_world
    ws = [M @ v.co for v in me.vertices]
    bb = [min(v.x for v in ws), max(v.x for v in ws), min(v.y for v in ws), max(v.y for v in ws),
          min(v.z for v in ws), max(v.z for v in ws)]
    gl = [M @ me.vertices[i].co for p in me.polygons if p.material_index == GLAS for i in p.vertices]
    gc = [(min(v[a] for v in gl) + max(v[a] for v in gl)) / 2 for a in range(3)]
    return {"object": NAME, "collection": COLL, "triangles": tris,
            "materials": [m.name for m in me.materials],
            "bbox": [round(x, 4) for x in bb], "glas_bbox_centre": [round(x, 4) for x in gc],
            "old_retired": {"hide_render": old.hide_render, "materials": [s.material.name for s in old.material_slots]},
            "textures": 0}


result = run()
_log(result)
if not os.environ.get("DP_LAMP_NOSAVE"):
    bpy.ops.wm.save_mainfile()
    _log("saved", bpy.data.filepath)
