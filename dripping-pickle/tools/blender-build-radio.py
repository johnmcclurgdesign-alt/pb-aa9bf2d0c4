# ENV-004 (#9) — the transistor radio, built from nothing. ORIGINAL GEOMETRY.
# Run INSIDE Blender, headless is the method:
#   blender -b <production>.blend -P tools/blender-build-radio.py
#
# ★ THIS SCRIPT IS THE AUTHORSHIP RECORD. `asset-provenance.csv` names it as the source and
#   the licence is `original`; there is no upstream file to point at, so if this script is
#   lost the provenance claim is lost with it. Same contract as tools/blender-build-mouse.py.
#
# WHAT IT REPLACES. The shipped `Prop_Radio_Transistor` was a UNIT CUBE scaled
# 0.095 x 0.24 x 0.15 with one flat material, plus six sub-part objects that were never
# more than slivers. The loop compensated by BUILDING an emissive quad at runtime and
# fitting it to that box (n047, "needs a better asset here"). Every one of the seven names
# is reused here, because `shadow-casters.json` lists all seven on its measured noCast list,
# `asset-provenance.csv` has a row per part, and the INT-002 hotspot resolves the body by
# name. A rename would silently drop all three.
#
# SIZE IS FROM THE ERA, AND IT LANDS WHERE THE PLACEHOLDER WAS ON PURPOSE. A GE P-780E-class
# portable is about 0.26 x 0.17 x 0.09; the placeholder's 0.24 x 0.15 x 0.095 was already
# close, so the body is 0.255 x 0.165 x 0.085 and the read barely moves. Measured at the ROOM
# pose it is 34 px wide and 22 px tall of 1280 x 720 — which is the whole brief for the
# detail: a silhouette, a dark grille, an amber dial. Anything finer than about 5 px is
# invisible and is not modelled.
#
# THE DIAL IS GEOMETRY NOW, NOT A RUNTIME QUAD. `Prop_Radio_Transistor_Dial` carries the
# material `Radio_Dial_Glow` — the name the equipment channel already drives from
# `assets/dripping-pickle/events/radio_{on,off}.json`. Emission colour ships amber at
# strength 1 and the LOOP owns `emissiveIntensity`, which it sets to 0 at load, so a radio
# that has never been pressed is dark.
#
# MATERIALS: THREE, AND THAT IS ONE FEWER THAN SHIPPED. The row's brief said two. The grille
# is most of what makes a cream box read as a radio at 34 px, so it keeps a dark material;
# the knobs and the antenna share it rather than carrying a fourth, and so does the HAM's
# grille next door — `Equipment_Dark` is deliberately shared across both props, because the
# render proxies merge by MATERIAL and a second dark material would be a second draw call
# for nothing. Shipped today: Radio_Transistor_Shell + Radio_Grille + Radio_Knob +
# Radio_Dial_Glow = four. After: Radio_Transistor_Shell + Equipment_Dark + Radio_Dial_Glow
# = three, and the two orphans are left in the blend unused rather than deleted. No textures
# at all, so this prop adds ZERO resident texture bytes.
#
# Placement is NOT here: tools/blender-seat-props.py seats everything that rests on
# something, against a MEASURED surface, absolutely. This script builds at the origin and
# then asks that module where the radio goes.
import bpy, os, math

REPO = os.environ.get("DP_REPO") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))

# ── the object names, in the order they are built ────────────────────────────
BODY    = "Prop_Radio_Transistor"
DIAL    = "Prop_Radio_Transistor_Dial"
GRILLE  = "Prop_Radio_Transistor_Grille"
KNOB0   = "Prop_Radio_Transistor_Knob_0"
KNOB1   = "Prop_Radio_Transistor_Knob_1"
HANDLE  = "Prop_Radio_Transistor_Handle"
ANTENNA = "Prop_Radio_Transistor_Antenna"
OWNED   = [BODY, DIAL, GRILLE, KNOB0, KNOB1, HANDLE, ANTENNA]

# ── the case, in metres, in the object's own frame ───────────────────────────
# +X is depth (toward the front wall), +Y is width, +Z is up, origin on the base plane.
D, W, H = 0.085, 0.255, 0.165
FRONT   = -D / 2.0          # the face that looks at the loop camera
CHAMFER = 0.008             # a wrap-around case, not a brick — 8-gon in plan


def _log(*a):
    print("[build-radio]", *a)


def mat(name, base, rough, metal, emis=None, emis_strength=1.0):
    """A Principled BSDF and an Output, and NOTHING ELSE.

    The tree is rebuilt from scratch every time on purpose. `Radio_Dial_Glow` already
    existed in this blend with no Principled node at all (the runtime used to build the
    dial), and nothing but Principled survives the glTF trip — a leftover node is dropped
    silently with a warning nobody reads.
    """
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
    if 'Emission Color' in b.inputs:
        b.inputs['Emission Color'].default_value = (*(emis or (0, 0, 0)), 1.0)
        b.inputs['Emission Strength'].default_value = emis_strength if emis else 0.0
    return m


def mesh_obj(name, verts, faces, material, coll):
    """Replace any object of this name, in place, keeping the name — see the header."""
    old = bpy.data.objects.get(name)
    if old is not None:
        bpy.data.objects.remove(old, do_unlink=True)
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    me.shade_flat()
    o = bpy.data.objects.new(name, me)
    me.materials.append(material)
    coll.objects.link(o)
    return o


def box(x0, x1, y0, y1, z0, z1):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
         (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
         (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return v, f


def prism8(hx, hy, z0, z1, ch):
    """A box with its four vertical edges cut — the wrap-around case read, 8-gon in plan."""
    ring = [(-hx + ch, -hy), (hx - ch, -hy), (hx, -hy + ch), (hx, hy - ch),
            (hx - ch, hy), (-hx + ch, hy), (-hx, hy - ch), (-hx, -hy + ch)]
    v = [(x, y, z0) for x, y in ring] + [(x, y, z1) for x, y in ring]
    n = len(ring)
    f = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    f += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    return v, f


def cyl(cx, cy, cz, axis, r, length, seg=12):
    """A short cylinder along one axis — knobs (X) and the antenna (Z)."""
    v, f = [], []
    for end in (0, 1):
        for i in range(seg):
            a = 2 * math.pi * i / seg
            c, s = r * math.cos(a), r * math.sin(a)
            d = length * end
            v.append((cx + d, cy + c, cz + s) if axis == 'X' else (cx + c, cy + s, cz + d))
    f.append(tuple(range(seg - 1, -1, -1)))
    f.append(tuple(range(seg, 2 * seg)))
    f += [(i, (i + 1) % seg, seg + (i + 1) % seg, seg + i) for i in range(seg)]
    return v, f


def strap(pts, half_w, thick):
    """Sweep a rectangular section along a polyline in the YZ plane — the carry handle."""
    v, f = [], []
    for (y, z) in pts:
        v += [(-half_w, y, z), (half_w, y, z), (half_w, y, z - thick), (-half_w, y, z - thick)]
    for i in range(len(pts) - 1):
        a, b = 4 * i, 4 * (i + 1)
        f += [(a, b, b + 1, a + 1), (a + 1, b + 1, b + 2, a + 2),
              (a + 2, b + 2, b + 3, a + 3), (a + 3, b + 3, b, a)]
    n = len(v)
    f += [(0, 1, 2, 3), (n - 4, n - 3, n - 2, n - 1)]
    return v, f


def run():
    props = bpy.data.collections.get("Props")
    assert props, "no Props collection — a prop built into the scene root is the floor-lamp trap"

    # ── materials ────────────────────────────────────────────────────────────
    # The shell colour is the one already in the picture, carried over deliberately: this
    # row changes the shape of the radio, not the room's palette.
    shell = mat("Radio_Transistor_Shell", (0.62, 0.44, 0.25), 0.55, 0.0)
    dark = mat("Equipment_Dark", (0.045, 0.045, 0.050), 0.65, 0.25)
    # ⚠ BLENDER'S EMISSION COLOUR IS LINEAR, AND SO IS glTF's `emissiveFactor`. Typing the
    # amber as if it were sRGB ships a much paler dial: (1.0, 0.70, 0.36) reached the browser
    # as #ffdaa2 and clipped to WHITE at the 2.4 intensity `radio_on.json` drives, measured in
    # the ROOM still at ART1. These are the linear values of #ffb35c — the amber the built
    # quad shipped with and Josh signed at DP-W8.
    glow = mat("Radio_Dial_Glow", (0.120, 0.070, 0.030), 0.40, 0.0,
               emis=(1.000, 0.435, 0.108), emis_strength=1.0)

    built = []

    # ── 1. the case ──────────────────────────────────────────────────────────
    v, f = prism8(D / 2, W / 2, 0.0, H, CHAMFER)
    built.append(mesh_obj(BODY, v, f, shell, props))

    # ── 2. the dial window, across the top of the front face ─────────────────
    # 1.5 mm PROUD of the case, not recessed: a recessed emissive panel loses most of its
    # patch to the bezel's own shadow at this size, and the whole point of this part is
    # that the 16 px patch INT-002 measures gets brighter when the radio is on.
    v, f = box(FRONT - 0.0015, FRONT, -0.110, 0.050, 0.100, 0.150)
    built.append(mesh_obj(DIAL, v, f, glow, props))

    # ── 3. the speaker grille, under the dial ────────────────────────────────
    v, f = box(FRONT - 0.0015, FRONT, -0.110, 0.020, 0.022, 0.088)
    built.append(mesh_obj(GRILLE, v, f, dark, props))

    # ── 4. two knobs on the right of the front face ──────────────────────────
    v, f = cyl(FRONT - 0.012, 0.088, 0.115, 'X', 0.017, 0.012)
    built.append(mesh_obj(KNOB0, v, f, dark, props))
    v, f = cyl(FRONT - 0.012, 0.088, 0.055, 'X', 0.017, 0.012)
    built.append(mesh_obj(KNOB1, v, f, dark, props))

    # ── 5. the carry handle, a strap over the top ────────────────────────────
    arc = [(-0.092, H), (-0.082, H + 0.028), (-0.055, H + 0.043), (0.0, H + 0.048),
           (0.055, H + 0.043), (0.082, H + 0.028), (0.092, H)]
    v, f = strap(arc, 0.009, 0.009)
    built.append(mesh_obj(HANDLE, v, f, shell, props))

    # ── 6. the antenna, from the back right corner ───────────────────────────
    ant = mesh_obj(ANTENNA, *cyl(0.022, 0.104, H, 'Z', 0.0035, 0.300, seg=6), dark, props)
    ant.rotation_euler = (math.radians(-11.0), math.radians(6.0), 0.0)
    built.append(ant)

    # ── every part shares the body's placement ───────────────────────────────
    # The seat script owns WHERE. Here they are only made to agree with each other, so a
    # later absolute move of the body carries the whole radio with it.
    for o in built:
        o.location = (0.0, 0.0, 0.0)
        if o.name != ANTENNA:
            o.rotation_euler = (0.0, 0.0, 0.0)
        o.scale = (1.0, 1.0, 1.0)

    tris = sum(len(o.data.polygons) + sum(len(p.vertices) - 3 for p in o.data.polygons)
               for o in built)
    return {"objects": [o.name for o in built],
            "materials": sorted({m.name for o in built for m in o.data.materials}),
            "body_size": [D, W, H], "triangles": tris,
            "textures": 0}


result = run()
_log(result)
