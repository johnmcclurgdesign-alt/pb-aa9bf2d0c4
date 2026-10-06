# ENV-005 (#10) — the HAM receiver, built from nothing. ORIGINAL GEOMETRY.
# Run INSIDE Blender, headless:
#   blender -b <production>.blend -P tools/blender-build-ham.py
#
# ★ THIS SCRIPT IS THE AUTHORSHIP RECORD — see tools/blender-build-radio.py's header for the
#   provenance contract. Licence `original`, source this file.
#
# WHAT IT ADDS. Unlike the radio (#9), which at least shipped a placeholder cube, there was
# NO HAM prop anywhere in the scene or the tooling, and no amber broadcast glow. Canon §4
# puts it on the right rack's lower shelves with stacked equipment boxes; Gate A §4.1 amends
# the rack to the rolling cart and keeps the shelf. It lands on the cart's MIDDLE shelf —
# measured, see tools/blender-seat-props.py — because the lower one already carries the two
# equipment boxes canon asks for and the middle shelf is the one the ROOM camera reaches
# without the desk in front of it.
#
# SIZE IS FROM THE ERA. A 1960s-70s communications receiver (Hammarlund / Drake class) is
# about 0.40 x 0.19 x 0.28. Measured at the ROOM pose that is 52 px wide and 25 px tall of
# 1280 x 720, and the amber window is about 19 x 7 px — the same order as the radio dial's
# 16 px patch, which is the patch INT-002 already measures on/off. So the modelling stops at
# the silhouette, the dark grille, the knob row and the window; nothing finer reads.
#
# THE GLOW IS ON THE CAMERA-FACING FACE, AND IT IS ITS OWN MESH. Putting emission on the
# chassis material would light the whole box like a lamp — the exact trap the radio's
# placeholder was built around (docs/lessons/the-radio-is-a-unit-cube-with-one-material).
# `Prop_HAM_Receiver_Dial` carries `HAM_Glow` alone; the loop owns `emissiveIntensity` and
# sets it to 0 at load, so a receiver that is not broadcasting is dark.
#
# MATERIALS: TWO NEW. `HAM_Chassis` and `HAM_Glow`, plus the `Equipment_Dark` the radio
# already introduced, deliberately SHARED so the render proxies merge the two props' dark
# parts into one draw. No textures — this prop adds ZERO resident texture bytes.
import bpy, os, math

REPO = os.environ.get("DP_REPO") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))

CHASSIS = "Prop_HAM_Receiver"
DIAL    = "Prop_HAM_Receiver_Dial"
PANEL   = "Prop_HAM_Receiver_Panel"
OWNED   = [CHASSIS, DIAL, PANEL]

# +X is depth (toward the front wall), +Y is width, +Z is up, origin on the base plane.
D, W, H = 0.28, 0.40, 0.19
FRONT   = -D / 2.0          # the face that looks at the loop camera
PANEL_X = FRONT - 0.004     # the front panel stands 4 mm proud of the case


def _log(*a):
    print("[build-ham]", *a)


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


def box(x0, x1, y0, y1, z0, z1, v=None, f=None):
    v = [] if v is None else v
    f = [] if f is None else f
    o = len(v)
    v += [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
          (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f += [(o + 0, o + 3, o + 2, o + 1), (o + 4, o + 5, o + 6, o + 7),
          (o + 0, o + 1, o + 5, o + 4), (o + 1, o + 2, o + 6, o + 5),
          (o + 2, o + 3, o + 7, o + 6), (o + 3, o + 0, o + 4, o + 7)]
    return v, f


def prism8(hx, hy, z0, z1, ch, v=None, f=None):
    """A case with its vertical edges broken — reads as pressed steel, not a brick."""
    v = [] if v is None else v
    f = [] if f is None else f
    o = len(v)
    ring = [(-hx + ch, -hy), (hx - ch, -hy), (hx, -hy + ch), (hx, hy - ch),
            (hx - ch, hy), (-hx + ch, hy), (-hx, hy - ch), (-hx, -hy + ch)]
    v += [(x, y, z0) for x, y in ring] + [(x, y, z1) for x, y in ring]
    n = len(ring)
    f += [tuple(range(o + n - 1, o - 1, -1)), tuple(range(o + n, o + 2 * n))]
    f += [(o + i, o + (i + 1) % n, o + n + (i + 1) % n, o + n + i) for i in range(n)]
    return v, f


def cyl_x(cx, cy, cz, r, length, seg=10, v=None, f=None):
    v = [] if v is None else v
    f = [] if f is None else f
    o = len(v)
    for end in (0, 1):
        for i in range(seg):
            a = 2 * math.pi * i / seg
            v.append((cx + length * end, cy + r * math.cos(a), cz + r * math.sin(a)))
    f.append(tuple(range(o + seg - 1, o - 1, -1)))
    f.append(tuple(range(o + seg, o + 2 * seg)))
    f += [(o + i, o + (i + 1) % seg, o + seg + (i + 1) % seg, o + seg + i) for i in range(seg)]
    return v, f


def mesh_obj(name, verts, faces, material, coll):
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
    o.location = (0.0, 0.0, 0.0)
    o.rotation_euler = (0.0, 0.0, 0.0)
    o.scale = (1.0, 1.0, 1.0)
    return o


def run():
    props = bpy.data.collections.get("Props")
    assert props, "no Props collection — a prop built into the scene root is the floor-lamp trap"

    # Grey-green crackle-finish steel: canon §9's brine green and warm beige, aged, never new.
    chassis = mat("HAM_Chassis", (0.115, 0.125, 0.105), 0.60, 0.45)
    dark = mat("Equipment_Dark", (0.045, 0.045, 0.050), 0.65, 0.25)
    # ⚠ LINEAR, not sRGB — see the note in tools/blender-build-radio.py. #ffa83c, a deeper
    # amber than the radio's dial because canon §4 calls this one "amber dials and a warm
    # glow" against the radio's "softly illuminated".
    glow = mat("HAM_Glow", (0.120, 0.070, 0.020), 0.40, 0.0,
               emis=(1.000, 0.376, 0.043), emis_strength=1.0)

    built = []

    # ── 1. the case, plus the front panel standing proud of it ───────────────
    v, f = prism8(D / 2, W / 2, 0.0, H, 0.010)
    v, f = box(PANEL_X, FRONT, -0.185, 0.185, 0.012, 0.178, v, f)
    built.append(mesh_obj(CHASSIS, v, f, chassis, props))

    # ── 2. the tuning window — the amber broadcast glow, camera-facing ───────
    v, f = box(PANEL_X - 0.0015, PANEL_X, -0.170, -0.020, 0.100, 0.155)
    built.append(mesh_obj(DIAL, v, f, glow, props))

    # ── 3. the dark furniture: speaker grille and the knob row ───────────────
    v, f = box(PANEL_X - 0.0015, PANEL_X, 0.020, 0.170, 0.030, 0.150)
    for ky in (-0.150, -0.100, -0.050):
        v, f = cyl_x(PANEL_X - 0.014, ky, 0.045, 0.013, 0.014, 10, v, f)
    v, f = cyl_x(PANEL_X - 0.016, 0.000, 0.055, 0.021, 0.016, 12, v, f)   # the big tuning knob
    built.append(mesh_obj(PANEL, v, f, dark, props))

    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in built)
    return {"objects": [o.name for o in built],
            "materials": sorted({m.name for o in built for m in o.data.materials}),
            "case_size": [D, W, H], "triangles": tris, "textures": 0}


result = run()
_log(result)
