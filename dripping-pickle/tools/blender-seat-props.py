# ENV-021 (#98) — seat everything that rests on something, against a MEASURED surface.
# Run INSIDE Blender, headless, AFTER the three build scripts:
#   blender -b <production>.blend -P tools/blender-seat-props.py
#
# ★ "IT SITS ON X" IS A CLAIM ABOUT A SURFACE, NOT ABOUT A BOUNDING BOX. Three defects in
#   this scene were one mistake and each cost a session: the radio at the left CRT's bbox
#   `max.x` shipped outside the room and never rendered (#82), the crate stack stood inside
#   a chest of drawers, and a cable run reached a metre outside the building. #98 is the
#   same class again, from the reviewer's own notes. This file is the class fixed once.
#
# THE MEASUREMENT, in two raycasts and no bounding boxes anywhere:
#
#   CONTACT FACE of the resting object — cast UP from below it on a grid; the first hit is
#     its lowest surface at that (x, y). Samples within `FACE_TOL` of its own zmin are the
#     face it actually rests on. (`n_base` collapsing to 1 at 4 mm and jumping to 459 at
#     50 mm is how you learn a prop's "flat" base is a 3 cm dished pressing.)
#   SUPPORT at a NAMED LEVEL — cast DOWN onto the supporting object from just above the
#     level; a hit within `LEVEL_TOL` of it is deck, anything else is not. Naming the level
#     is not pedantry: the cart has surfaces at 0.813, 0.500 and 0.187, and "cast down onto
#     the cart" silently answers about whichever one the ray met first.
#
#   Then dz = level - zmin, and the seat is good when every contact sample has that level
#   under it.
#
# ★ EVERY MOVE IS ABSOLUTE. Each entry says "put the contact face's centre HERE and its
#   underside ON that level", computed from the object's CURRENT state, so re-running this
#   file is a no-op. A delta walks the prop further every run, and this file exists to be
#   re-run — it is also the assert that the props still sit where they are supposed to after
#   a re-dress or a re-export.
#
# ★ AND A SEAT IS NOT FINISHED UNTIL THE CAMERA AGREES. The wall plane assert below is the
#   #82 test written down: a prop whose every part is past x = 2.0688 is inside the front
#   wall and simply never renders, with scale, collection and geometry checks all coming
#   back clean. `--check` re-runs the measurement without moving anything.
import bpy, os, sys, math, json
from mathutils import Vector
from mathutils.bvhtree import BVHTree

REPO = os.environ.get("DP_REPO") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))

WALL_X     = 2.0688      # `wall_standard_standard_01.005`, measured: min.x == max.x
FACE_TOL   = 0.050       # a sample this close to the object's zmin is its resting face
LEVEL_TOL  = 0.006       # a support hit this close to the named level is that surface
GRID       = 31          # samples per axis over a footprint
SEARCH     = 0.36        # half-width of the offset search, metres
SEARCH_N   = 25

_dg = None
_cache = {}


def _log(*a):
    print("[seat-props]", *a)


def bvh(obj):
    if obj.name in _cache:
        return _cache[obj.name]
    ev = obj.evaluated_get(_dg); me = ev.to_mesh(); M = obj.matrix_world
    vs = [tuple(M @ v.co) for v in me.vertices]
    me.calc_loop_triangles()
    tris = [tuple(t.vertices) for t in me.loop_triangles]
    ev.to_mesh_clear()
    t = BVHTree.FromPolygons(vs, tris, all_triangles=True)
    _cache[obj.name] = t
    return t


def wbb(obj):
    c = [obj.matrix_world @ Vector(v) for v in obj.bound_box]
    return (min(v.x for v in c), max(v.x for v in c),
            min(v.y for v in c), max(v.y for v in c),
            min(v.z for v in c), max(v.z for v in c))


def contact_face(obj):
    """[(x, y, z)] of the object's resting face — cast UP, keep what is near its own zmin."""
    t = bvh(obj)
    x0, x1, y0, y1, z0, z1 = wbb(obj)
    pts, foot = [], 0
    for i in range(GRID):
        for j in range(GRID):
            x = x0 + (x1 - x0) * (i + 0.5) / GRID
            y = y0 + (y1 - y0) * (j + 0.5) / GRID
            loc, _, _, _ = t.ray_cast(Vector((x, y, z0 - 0.05)), Vector((0, 0, 1)))
            if loc is None:
                continue
            foot += 1
            if loc.z - z0 <= FACE_TOL:
                pts.append((x, y, loc.z))
    return z0, foot, pts


def supported(pts, support, level, dx=0.0, dy=0.0):
    """How many of those samples have the NAMED level under them once shifted."""
    t = bvh(support)
    ok = 0
    for (x, y, _z) in pts:
        loc, _, _, _ = t.ray_cast(Vector((x + dx, y + dy, level + 0.05)), Vector((0, 0, -1)))
        if loc is not None and abs(loc.z - level) <= LEVEL_TOL:
            ok += 1
    return ok


def move(names, d):
    """Translate, then make the depsgraph agree.

    ⚠ Setting `location` does NOT update `matrix_world`, and every measurement here reads
    `matrix_world`. Without the view-layer update the re-measure below reads the OLD pose
    and reports the move as having failed — which is what it did the first time.
    """
    global _dg
    for n in names:
        o = bpy.data.objects.get(n)
        assert o is not None, "missing object %s" % n
        o.location = (o.location.x + d[0], o.location.y + d[1], o.location.z + d[2])
        _cache.pop(n, None)
    bpy.context.view_layer.update()
    _dg = bpy.context.evaluated_depsgraph_get()


def geom_x_max(obj):
    ev = obj.evaluated_get(_dg); me = ev.to_mesh(); M = obj.matrix_world
    mx = max((M @ v.co).x for v in me.vertices)
    ev.to_mesh_clear()
    return mx


def seat(name, support_name, level, target_xy=None, follow=(), floor=1.0, check=False):
    """Seat `name` (and whatever rides with it) on `support_name`'s surface at `level`."""
    o = bpy.data.objects[name]
    sup = bpy.data.objects[support_name]
    z0, foot, pts = contact_face(o)
    assert pts, "%s has no resting face within %.0f mm of its zmin" % (name, FACE_TOL * 1000)

    if target_xy is not None:
        cx = (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2
        cy = (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2
        dx, dy = target_xy[0] - cx, target_xy[1] - cy
    else:
        # No target given: find the SMALLEST move that gets the whole face supported. The
        # search is over absolute offsets from where the prop stands now, so once it is
        # seated the answer is (0, 0) and a second run does nothing.
        best = None
        for i in range(SEARCH_N):
            for j in range(SEARCH_N):
                ox = -SEARCH + 2 * SEARCH * i / (SEARCH_N - 1)
                oy = -SEARCH + 2 * SEARCH * j / (SEARCH_N - 1)
                frac = supported(pts, sup, level, ox, oy) / len(pts)
                key = (-round(frac, 4), round(abs(ox) + abs(oy), 4))
                if best is None or key < best[0]:
                    best = (key, ox, oy)
        dx, dy = best[1], best[2]

    dz = level - z0
    frac = supported(pts, sup, level, dx, dy) / len(pts)
    rep = {"obj": name, "on": support_name, "level": level,
           "zmin_before": round(z0, 4), "dxyz": [round(dx, 4), round(dy, 4), round(dz, 4)],
           "contact_samples": len(pts), "footprint_samples": foot,
           "supported_frac": round(frac, 4)}
    if not check:
        assert frac >= floor, (
            "%s would be %.1f%% supported on %s @ %.4f — below the %.0f%% floor; the surface "
            "is too small for the prop, which is a design question, not a placement one"
            % (name, 100 * frac, support_name, level, 100 * floor))
        move((name,) + tuple(follow), (dx, dy, dz))
        # Re-measure AFTER the move rather than trusting the arithmetic.
        z0b, _foot, ptsb = contact_face(bpy.data.objects[name])
        rep["zmin_after"] = round(z0b, 4)
        rep["supported_after"] = round(supported(ptsb, sup, level) / len(ptsb), 4)
        assert abs(z0b - level) < 1e-4, "%s landed at %.4f, not %.4f" % (name, z0b, level)
    return rep


# ── the seats, in the order they must run ────────────────────────────────────
# The cart before what stands on it; the CRT before what stands on the CRT.
#
# `target_xy` is a world point for the contact face's CENTRE. Where it is absent the
# script solves for the smallest fully-supported offset instead — used wherever the prop
# was already roughly right and only fell off its surface (#98's actual complaint).
SEATS = [
    # The TV keeps its place exactly: tools/blender-build-cart.py sized the deck FROM this
    # object's base rect and pinned the deck top to its base plane, so this is an assert,
    # not a move. floor 1.0 is the whole point of building the cart.
    dict(name="Prop_Screen_Right_CRT", support="Prop_Equipment_Cart", level=0.813,
         target_xy=None),
    # n048 — "Sit properly on top of TV". It floated 5.4 mm and 29.6% of its base hung off
    # the CRT's domed top.
    dict(name="Prop_Recorder.001", support="Prop_Screen_Right_CRT", level=1.5182),
    # n046 — "Does not sit on cart properly". Sunk 23 mm INTO the shelf.
    dict(name="Prop_Vintage_Spacecraft_Instrument_01.001",
         support="Prop_Equipment_Cart", level=0.187),
    # Not on #98's list and it is the same defect, found in the ROOM-pose still at ART1: it
    # floats 13 mm and most of its footprint is past the old shelf's edge, so it reads as a
    # box stuck to the brick. Same surface, same method, one more line.
    dict(name="Prop_Weird_Russian_Device.001",
         support="Prop_Equipment_Cart", level=0.187),
    # ENV-005 — the HAM on the cart's middle shelf, canon §4 / Gate A §4.1.
    dict(name="Prop_HAM_Receiver", support="Prop_Equipment_Cart", level=0.500,
         target_xy=(1.606, -1.967),
         follow=("Prop_HAM_Receiver_Dial", "Prop_HAM_Receiver_Panel")),
    # ENV-004 — the radio on the left CRT's MEASURED top deck (z 1.7223), at the footprint
    # centre the #82 fix solved for. Not the bbox: the bbox top is a corner of a domed tube.
    dict(name="Prop_Radio_Transistor", support="Prop_Screen_Left_CRT", level=1.7223,
         target_xy=(1.4784, 1.6242),
         follow=("Prop_Radio_Transistor_Dial", "Prop_Radio_Transistor_Grille",
                 "Prop_Radio_Transistor_Knob_0", "Prop_Radio_Transistor_Knob_1",
                 "Prop_Radio_Transistor_Handle", "Prop_Radio_Transistor_Antenna")),
    # ART2 (#75) — the original floor lamp, on the GROUND (`SM_DPW_Ground_001.002`, measured
    # z 0.0120 under it), base centred on the pole axis the old lamp stood on. The old lamp's
    # disc sat 4.2 mm INTO the ground, so this is a real move (+0.0042), and the light that
    # lightLamp() plants at the bulb rides up with it by the same 4 mm.
    # ⚠ In plan the disc (r 0.115, the old lamp's own footprint, kept) runs under the two crates
    # either side of it — `Prop_Crate_Left_Lower` and `Prop_Old_Wooden_Crate.002` — which a
    # down-cast from 0.5 m meets at their tops (0.47, 0.35). The seat's own cast starts 5 cm over
    # the ground and reads 371/371 of the contact face supported; the overlap is with crate
    # bodies standing on the same floor, invisible from both declared poses, and was the old
    # lamp's too.
    dict(name="Prop_Floor_Lamp", support="SM_DPW_Ground_001.002", level=0.0120,
         target_xy=(0.3966, 1.9097), collection="Props_Lamp"),
]

# Props whose whole body must be on the room side of the front wall. The array and the cart
# are deliberately NOT here: a screen pushed against a wall has its back in the brick, which
# is invisible and correct. A radio does not.
WALL_ASSERT = ["Prop_Radio_Transistor", "Prop_Radio_Transistor_Antenna",
               "Prop_Radio_Transistor_Dial", "Prop_Radio_Transistor_Grille",
               "Prop_Radio_Transistor_Handle", "Prop_Radio_Transistor_Knob_0",
               "Prop_Radio_Transistor_Knob_1",
               "Prop_HAM_Receiver", "Prop_HAM_Receiver_Dial", "Prop_HAM_Receiver_Panel"]


def run(check=False):
    global _dg
    _dg = bpy.context.evaluated_depsgraph_get()
    props = bpy.data.collections.get("Props")
    assert props, "no Props collection"

    report = []
    for s in SEATS:
        _cache.clear()
        report.append(seat(s["name"], s["support"], s["level"],
                           s.get("target_xy"), s.get("follow", ()),
                           s.get("floor", 1.0), check))
        _log(report[-1])

    # ── the #82 assert: is any of this inside the front wall? ───────────────
    _cache.clear()
    _dg = bpy.context.evaluated_depsgraph_get()
    walls = []
    for n in WALL_ASSERT:
        o = bpy.data.objects.get(n)
        if o is None:
            continue
        mx = geom_x_max(o)
        walls.append({"obj": n, "x_max": round(mx, 4), "wall": WALL_X, "inside": mx < WALL_X})
    bad = [w for w in walls if not w["inside"]]
    if not check:
        assert not bad, "past the front wall plane (#82's defect, exactly): %s" % bad

    # ── every prop this row owns must be in the Props collection ────────────
    # The floor-lamp trap in the other direction: an object in `Scene Collection` is not
    # seen by the props exporter and needs a glb of its own.
    # A prop that ships in its OWN glb (the floor lamp, ART2) names its collection in its seat
    # entry; everything else must be in `Props`. Either way, never the scene root.
    owned = [(s["name"], s.get("collection", "Props")) for s in SEATS] \
            + [(n, s.get("collection", "Props")) for s in SEATS for n in s.get("follow", ())] \
            + [("Prop_Equipment_Cart", "Props")]
    stray = [n for n, want in owned
             if bpy.data.objects.get(n)
             and want not in [c.name for c in bpy.data.objects[n].users_collection]]
    assert not stray, "not in the Props collection (the floor-lamp trap): %s" % stray

    return {"seats": report, "wall": walls, "collection_ok": True}


result = run(check=("--check" in sys.argv))
print("===SEAT-JSON===")
print(json.dumps(result, indent=1))
