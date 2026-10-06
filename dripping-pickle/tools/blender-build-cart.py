# ENV-021 (#98 n049) — the equipment cart, built from nothing. ORIGINAL GEOMETRY.
# Run INSIDE Blender, headless:
#   blender -b <production>.blend -P tools/blender-build-cart.py
#
# ★ THIS SCRIPT IS THE AUTHORSHIP RECORD — see tools/blender-build-radio.py's header.
#
# WHY THIS PROP EXISTS, AND IT IS NOT WHAT THE ROW WAS SCOPED FOR. Reviewer note n049 says
# "TV asset overlaps cart, doesn't correctly sit ON it". Measured in this .blend at ART1:
# the right CRT's base footprint is 0.841 x 1.115 m and `Prop_Tool_Cart`'s measured top deck
# is 1.009 x 0.635 m — the same rectangle turned ninety degrees. Only 62.7% of the TV's base
# has deck under it, and a +/-0.30 m offset search tops out at 64.2%: THERE IS NO TRANSLATION
# THAT FIXES IT, which is the whole point of measuring before moving. (The TV is also about
# 2.2x the 0.50 x 0.46 body Gate A §4.1 signed for it.) Josh's call at the ART1 interview,
# 2026-09-11: build a cart sized to the TV rather than shrink the TV, so the array is not
# touched. `Prop_Tool_Cart` is RETIRED WITH `hide_render`, never deleted — it stays in the
# blend for John, and `blender-export-props.py` keeps it out of the payload.
#
# ★ THE DECK IS MEASURED FROM THE TV, NOT TYPED. The numbers above are this session's; a
# re-dress that resizes the right CRT would make a typed deck wrong in exactly the silent way
# n049 already is. So the deck is sized here, at build time, from the CRT's own base rect in
# the cart's yaw frame, plus MARGIN. Its TOP is pinned to the CRT's measured base plane
# (z = 0.813 today) so building this cart MOVES THE TV NOT AT ALL.
#
# THE SHELF LEVELS ARE THE OLD CART'S, ON PURPOSE. The lower shelf is at z = 0.187 because
# that is where `Prop_Vintage_Spacecraft_Instrument_01.001` and `Prop_Weird_Russian_Device.001`
# already stand (badly — see tools/blender-seat-props.py), so keeping the level means the two
# equipment boxes canon §4 asks for do not have to be re-composed. A middle shelf at 0.500 is
# new, and it is where the HAM goes: measured from the ROOM eye, the lower shelf is the one
# the right-hand desk cuts into, and 0.313 m of extra height buys the receiver a clean sightline.
#
# MATERIALS: ONE, `Equipment_Cart_Steel`, no textures. It replaces `tool_cart`, which carried
# FOUR 2K images (diffuse, metal, rough, normal) — so retiring the bought cart is a resident
# texture REDUCTION, not a cost.
import bpy, os, math
from mathutils import Vector

REPO = os.environ.get("DP_REPO") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))

CART   = "Prop_Equipment_Cart"
OLD    = "Prop_Tool_Cart"
TV     = "Prop_Screen_Right_CRT"
YAW    = math.radians(-14.0)        # the array's toe-in; the old cart carried it too

MARGIN     = 0.060                  # deck overhang beyond the TV's base rect, each side
DECK_TOP   = None                   # measured: the TV's own base plane
DECK_T     = 0.024                  # deck plate thickness
SHELF_T    = 0.018
SHELF_MID  = 0.500                  # top of the middle shelf — the HAM's surface
SHELF_LOW  = 0.187                  # measured: where the two equipment boxes already stand
LEG        = 0.034                  # square upright
CASTOR_R   = 0.026
CASTOR_TOP = 0.085
FLOOR      = 0.012
LIP_H      = 0.030
LIP_T      = 0.012


def _log(*a):
    print("[build-cart]", *a)


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


def box(x0, x1, y0, y1, z0, z1, v, f):
    o = len(v)
    v += [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
          (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f += [(o + 0, o + 3, o + 2, o + 1), (o + 4, o + 5, o + 6, o + 7),
          (o + 0, o + 1, o + 5, o + 4), (o + 1, o + 2, o + 6, o + 5),
          (o + 2, o + 3, o + 7, o + 6), (o + 3, o + 0, o + 4, o + 7)]
    return v, f


def cyl_z(cx, cy, z0, z1, r, v, f, seg=10):
    o = len(v)
    for z in (z0, z1):
        for i in range(seg):
            a = 2 * math.pi * i / seg
            v.append((cx + r * math.cos(a), cy + r * math.sin(a), z))
    f.append(tuple(range(o + seg - 1, o - 1, -1)))
    f.append(tuple(range(o + seg, o + 2 * seg)))
    f += [(o + i, o + (i + 1) % seg, o + seg + (i + 1) % seg, o + seg + i) for i in range(seg)]
    return v, f


def measure_tv_base():
    """The CRT's base rect in the cart's yaw frame, by RAYCAST from below — never a bbox.

    Cast up from under the object and take the first hit: that is its lowest surface at each
    (x, y). Samples within 50 mm of its own zmin are its resting face; their extent in the
    -14 deg frame is the rectangle the deck has to carry. `a-bounding-box-extent-is-not-a-
    visible-surface` is the lesson this replaces.
    """
    from mathutils.bvhtree import BVHTree
    o = bpy.data.objects[TV]
    dg = bpy.context.evaluated_depsgraph_get()
    ev = o.evaluated_get(dg); me = ev.to_mesh(); M = o.matrix_world
    vs = [tuple(M @ v.co) for v in me.vertices]
    me.calc_loop_triangles()
    tris = [tuple(t.vertices) for t in me.loop_triangles]
    ev.to_mesh_clear()
    tree = BVHTree.FromPolygons(vs, tris, all_triangles=True)
    xs = [p[0] for p in vs]; ys = [p[1] for p in vs]; zs = [p[2] for p in vs]
    z0 = min(zs)
    c, s = math.cos(-YAW), math.sin(-YAW)
    us, vv = [], []
    N = 41
    for i in range(N):
        for j in range(N):
            x = min(xs) + (max(xs) - min(xs)) * (i + 0.5) / N
            y = min(ys) + (max(ys) - min(ys)) * (j + 0.5) / N
            loc, _, _, _ = tree.ray_cast(Vector((x, y, z0 - 0.05)), Vector((0, 0, 1)))
            if loc is None or loc.z - z0 > 0.05:
                continue
            us.append(c * x - s * y); vv.append(s * x + c * y)
    assert us, "the right CRT has no resting face within 50 mm of its zmin"
    return dict(zmin=z0, u=(min(us), max(us)), v=(min(vv), max(vv)), n=len(us))


def run():
    props = bpy.data.collections.get("Props")
    assert props, "no Props collection — a prop built into the scene root is the floor-lamp trap"

    base = measure_tv_base()
    global DECK_TOP
    DECK_TOP = base["zmin"]
    # Deck rect in the yaw frame, then expressed relative to its own centre: the object
    # carries the centre as its location, so this is an ABSOLUTE placement and re-running
    # the script is a no-op (docs/lessons/grouped-moves-must-be-absolute).
    u0, u1 = base["u"][0] - MARGIN, base["u"][1] + MARGIN
    v0, v1 = base["v"][0] - MARGIN, base["v"][1] + MARGIN
    cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
    hx, hy = (u1 - u0) / 2, (v1 - v0) / 2

    steel = mat("Equipment_Cart_Steel", (0.075, 0.115, 0.085), 0.62, 0.35)
    v, f = [], []

    # ── the deck, and a lip so it reads as a utility cart and not a table ────
    box(-hx, hx, -hy, hy, DECK_TOP - DECK_T, DECK_TOP, v, f)
    for (a, b, cc, d) in [(-hx, -hx + LIP_T, -hy, hy), (hx - LIP_T, hx, -hy, hy),
                          (-hx, hx, -hy, -hy + LIP_T), (-hx, hx, hy - LIP_T, hy)]:
        box(a, b, cc, d, DECK_TOP, DECK_TOP + LIP_H, v, f)

    # ── two shelves, each with a downturned edge — the steel-shelf read ─────
    for top in (SHELF_MID, SHELF_LOW):
        box(-hx, hx, -hy, hy, top - SHELF_T, top, v, f)
        for (a, b, cc, d) in [(-hx, -hx + LIP_T, -hy, hy), (hx - LIP_T, hx, -hy, hy),
                              (-hx, hx, -hy, -hy + LIP_T), (-hx, hx, hy - LIP_T, hy)]:
            box(a, b, cc, d, top - SHELF_T - 0.022, top - SHELF_T, v, f)

    # ── four uprights and four castors ──────────────────────────────────────
    for sx in (-1, 1):
        for sy in (-1, 1):
            lx = sx * (hx - LEG / 2 - 0.006)
            ly = sy * (hy - LEG / 2 - 0.006)
            box(lx - LEG / 2, lx + LEG / 2, ly - LEG / 2, ly + LEG / 2,
                CASTOR_TOP, DECK_TOP - DECK_T, v, f)
            cyl_z(lx, ly, FLOOR, CASTOR_TOP, CASTOR_R, v, f)

    old = bpy.data.objects.get(CART)
    if old is not None:
        bpy.data.objects.remove(old, do_unlink=True)
    me = bpy.data.meshes.new(CART)
    me.from_pydata(v, [], f)
    me.validate()
    me.shade_flat()
    me.materials.append(steel)
    o = bpy.data.objects.new(CART, me)
    props.objects.link(o)
    # World placement: the yaw frame's inverse, so the deck centre lands on (cu, cv).
    c, s = math.cos(YAW), math.sin(YAW)
    o.location = (c * cu - s * cv, s * cu + c * cv, 0.0)
    o.rotation_euler = (0.0, 0.0, YAW)
    o.scale = (1.0, 1.0, 1.0)

    # ── retire the bought cart. hide_render, never delete ───────────────────
    tool = bpy.data.objects.get(OLD)
    retired = False
    if tool is not None and not tool.hide_render:
        tool.hide_render = True
        retired = True

    return {"object": CART, "deck_top": round(DECK_TOP, 4),
            "deck_size": [round(2 * hx, 4), round(2 * hy, 4)],
            "tv_base_rect": [round(base["u"][1] - base["u"][0], 4),
                             round(base["v"][1] - base["v"][0], 4)],
            "margin": MARGIN, "shelves": [SHELF_MID, SHELF_LOW],
            "triangles": sum(len(p.vertices) - 2 for p in me.polygons),
            "materials": ["Equipment_Cart_Steel"], "textures": 0,
            "retired_prop_tool_cart": retired}


result = run()
_log(result)
