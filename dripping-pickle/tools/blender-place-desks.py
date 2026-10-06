# ENV-013 (#77) — the three workstations, and the moves that made room for them.
# Run INSIDE Blender (headless is fine: blender -b <file>.blend -P tools/blender-place-desks.py).
#
# Every placement here is ABSOLUTE — "move so the world bbox min lands at this point",
# computed from the object's CURRENT bbox — so re-running this is a no-op. A delta would
# walk the object further on every run, and this file exists to be re-run: it is also the
# assert that the shot still frames what it is supposed to after a re-export.
#
# THE TWO POSES. Both are level and look +X, so for a point at blender x with d = x - eye_x:
#     frame half-width  = 0.75   * d      (Wide 24: hFov = 2*atan(18/24))
#     frame half-height = 0.4219 * d      (16:9)
#   ROOM   eye (-4.97,  -0.20, 1.30) — the declared camera.
#   SCREEN eye (-2.508, -0.286, 1.42) — solved in the loop from the array. The array's WIDTH
#          binds at every aspect from 2.39 to 0.5625, so this x does not move with the window;
#          it moves with FOCAL (24mm -2.508, 28mm -3.101, 35mm -4.14, 50mm -6.366).
#
# ★ "ON THE DESK" IS NOT "IN THE FRAME". At the desks' depth the ROOM frame's left edge is
#   y = +1.80 while the left desk runs to y = 2.30, so its outer half metre is off screen.
#   The workstation y is solved against the frame; the dressing is arranged around it.
import bpy, os, json, math
from mathutils import Vector

REPORT = os.environ.get("DP_DESK_REPORT", "/tmp/dp_desks.json")
log = {"moved": [], "created": [], "warn": []}

sc = bpy.data.scenes.get("Scene_60"); assert sc, "no Scene_60"
props = bpy.data.collections.get("Props"); assert props, "no Props collection"

def wbb(o):
    c = [o.matrix_world @ Vector(v) for v in o.bound_box]
    xs = [v.x for v in c]; ys = [v.y for v in c]; zs = [v.z for v in c]
    return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))

def place_min(name, tx=None, ty=None, tz=None, follow=()):
    o = sc.objects.get(name)
    if not o:
        log["warn"].append("missing %s" % name); return None
    b = wbb(o)
    d = (0.0 if tx is None else tx - b[0],
         0.0 if ty is None else ty - b[1],
         0.0 if tz is None else tz - b[2])
    for n in (name,) + tuple(follow):
        t = sc.objects.get(n)
        if not t:
            log["warn"].append("missing %s" % n); continue
        t.location = (t.location.x + d[0], t.location.y + d[1], t.location.z + d[2])
        log["moved"].append({"obj": n, "delta": [round(v, 4) for v in d]})
    return d

# ── 1. the vintage desk becomes the LEFT workstation ──────────────────────────
# It already faces +X (its user sits on the -x side), so this is a pure translate — and
# everything RESTING on it has to travel, or the clutter is left hanging in mid air.
# Lamp_Light_01 is Blender-only (the web loop derives its own light from the lamp MESH).
DESK_GROUP = ("Prop_Paper_Clutter_Documents", "Prop_Plastic_Thermos.001",
              "Prop_Metal_Toolbox.001", "Prop_Business_Letter", "Prop_Stapler",
              "Prop_Portable_Searchlight", "Prop_Study_Table_Lamp_Metal.001",
              "Prop_Books_Set.001",
              "Prop_Old_Computer_02.001",      # hide_render, but must not be left behind
              "Prop_Vintage_Wooden_Chair.001", # its chair
              "Lamp_Light_01")
place_min("Prop_Vintage_Desk", -3.050, 0.450, follow=DESK_GROUP)

# The outer end of that desk is the part the ROOM frame crops, so the tall dressing goes
# there and the kit stays in the visible band.
place_min("Prop_Portable_Searchlight",       -2.950, 1.800)
place_min("Prop_Study_Table_Lamp_Metal.001", -2.489, 1.850, follow=("Lamp_Light_01",))
place_min("Prop_Business_Letter",            -3.000, 0.600)
place_min("Prop_Stapler",                    -2.620, 0.850)

# ── 2. clear the RIGHT workstation's footprint ────────────────────────────────
# Deeper along the same wall, not sideways: -y would have put the ladder inside
# Prop_Cardboard_Box_SQ01.
place_min("Prop_Wooden_Ladder", -1.771)

# ── 3. materials ──────────────────────────────────────────────────────────────
def mat(name, base, rough, metal):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
    b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    assert b, "no Principled BSDF in %s" % name
    b.inputs["Base Color"].default_value = (*base, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m

M_STEEL = mat("Desk_Steel_Grey",     (0.075, 0.079, 0.086), 0.52, 0.30)
M_LAM   = mat("Desk_Laminate_Oak",   (0.126, 0.079, 0.040), 0.58, 0.00)
M_CHAIR = mat("Chair_Office_Dark",   (0.022, 0.023, 0.027), 0.78, 0.00)
M_SHELL = mat("Monitor_Shell_Black", (0.016, 0.017, 0.019), 0.62, 0.00)
M_GLASS = mat("Monitor_Glass_Off",   (0.008, 0.009, 0.012), 0.13, 0.00)

# ── 4. built geometry ─────────────────────────────────────────────────────────
class Build:
    """Boxes and prisms accumulated into ONE mesh, with a material index per piece."""
    def __init__(self): self.v = []; self.f = []; self.mi = []
    def box(self, cx, cy, cz, sx, sy, sz, m=0, yaw=0.0, ox=0.0, oy=0.0):
        hx, hy, hz = sx / 2, sy / 2, sz / 2
        pts = [(-hx,-hy,-hz),(hx,-hy,-hz),(hx,hy,-hz),(-hx,hy,-hz),
               (-hx,-hy, hz),(hx,-hy, hz),(hx,hy, hz),(-hx,hy, hz)]
        c, s = math.cos(yaw), math.sin(yaw)
        i = len(self.v)
        for (px, py, pz) in pts:
            lx, ly = px + cx - ox, py + cy - oy          # rotate about the pivot
            self.v.append((ox + lx*c - ly*s, oy + lx*s + ly*c, pz + cz))
        for q in [(0,1,2,3),(7,6,5,4),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]:
            self.f.append(tuple(i + k for k in q)); self.mi.append(m)
    def cyl(self, cx, cy, z0, z1, r, seg=10, m=0):
        i = len(self.v)
        for zz in (z0, z1):
            for k in range(seg):
                a = 2 * math.pi * k / seg
                self.v.append((cx + r*math.cos(a), cy + r*math.sin(a), zz))
        for k in range(seg):
            n = (k + 1) % seg
            self.f.append((i+k, i+n, i+seg+n, i+seg+k)); self.mi.append(m)
        self.f.append(tuple(i + seg + k for k in range(seg))); self.mi.append(m)
        self.f.append(tuple(i + k for k in range(seg - 1, -1, -1))); self.mi.append(m)
    def make(self, name, mats):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.v, [], self.f); me.validate()
        for p, m in zip(me.polygons, self.mi): p.material_index = m
        try: me.shade_flat()
        except Exception: pass
        ob = bpy.data.objects.new(name, me)
        for m in mats: ob.data.materials.append(m)
        props.objects.link(ob)
        log["created"].append(name)
        return ob

def replace(name):
    old = bpy.data.objects.get(name)
    if old:
        for c in list(old.users_collection): c.objects.unlink(old)
        bpy.data.objects.remove(old, do_unlink=True)

def tanker_desk(name, x0, x1, y0, y1, top_z, pedestal="right"):
    """Steel office-surplus desk: laminate top, drawer pedestal, modesty panel.
    Faces +X — the operator sits on the -x side."""
    b = Build()
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    dx, dy = x1 - x0, y1 - y0
    TOP = 0.030
    b.box(cx, cy, top_z - TOP/2, dx, dy, TOP, 1)
    ped_y = (y1 - 0.22) if pedestal == "right" else (y0 + 0.22)
    b.box(cx + 0.02, ped_y, (top_z - TOP)/2, dx - 0.10, 0.42, top_z - TOP, 0)
    for k in range(3):
        b.box(x0 + 0.03, ped_y, 0.16 + k*0.20, 0.02, 0.36, 0.16, 1)
    open_y = (y0 + 0.10) if pedestal == "right" else (y1 - 0.10)
    b.box(cx + 0.02, open_y, (top_z - TOP)/2, 0.05, 0.16, top_z - TOP, 0)
    b.box(x1 - 0.06, cy, (top_z - TOP)*0.62, 0.04, dy - 0.10, (top_z - TOP)*0.72, 0)
    return b.make(name, [M_STEEL, M_LAM])

def swivel_chair(name, cx, cy, yaw):
    """5-star base, gas column, seat, back. The yaw is the point: square-on reads as a
    showroom, and canon wants a chair that looks like somebody got up from it."""
    b = Build()
    b.cyl(cx, cy, 0.012, 0.045, 0.055, 10, 0)
    for k in range(5):
        a = 2 * math.pi * k / 5 + 0.4 + yaw
        px, py = cx + 0.14*math.cos(a), cy + 0.14*math.sin(a)
        b.box(px, py, 0.045, 0.28, 0.045, 0.035, 0, yaw=a, ox=px, oy=py)
    b.cyl(cx, cy, 0.045, 0.430, 0.030, 8, 0)
    b.box(cx, cy, 0.455, 0.46, 0.46, 0.070, 1, yaw=yaw, ox=cx, oy=cy)
    b.box(cx - 0.20, cy, 0.660, 0.055, 0.42, 0.34, 1, yaw=yaw, ox=cx, oy=cy)
    return b.make(name, [M_STEEL, M_CHAIR])

def workstation(name, top_z, mon_cy, kb_cy, mon_cx=-2.300, kb_cx=-2.700):
    """The uniform kit: a 16:9 panel on a slim stand, and a keyboard. The screen faces -X,
    which is where the operator sits and where the camera is."""
    b = Build()
    b.box(mon_cx, mon_cy, top_z + 0.0075, 0.22, 0.17, 0.015, 0)   # stand foot
    b.box(mon_cx, mon_cy, top_z + 0.070,  0.05, 0.05, 0.110, 0)   # column
    b.box(mon_cx, mon_cy, top_z + 0.290,  0.024, 0.55, 0.330, 0)  # panel
    b.box(mon_cx - 0.014, mon_cy, top_z + 0.292, 0.006, 0.515, 0.298, 1)   # dead glass
    b.box(kb_cx, kb_cy, top_z + 0.011, 0.155, 0.42, 0.022, 0)     # keyboard
    return b.make(name, [M_SHELL, M_GLASS])

for n in ("Prop_Desk_Right", "Prop_Chair_Right", "Prop_Desk_Centre", "Prop_Chair_Centre",
          "Prop_Camera_Monitor", "Prop_Workstation_Left", "Prop_Workstation_Right"):
    replace(n)

# RIGHT — in frame, lower right. Mismatched against the vintage desk on purpose.
tanker_desk("Prop_Desk_Right", -3.05, -2.15, -2.40, -0.90, 0.75, "right")
swivel_chair("Prop_Chair_Right", -3.470, -1.250, 0.42)   # slid inboard, or the frame eats it
# CENTRE — the camera's own desk. Out of shot in BOTH poses: under the room frustum (whose
# bottom edge at this depth is z 1.21) and behind the screen eye. Built anyway, because the
# camera has to be standing on something and #68 will want more poses.
tanker_desk("Prop_Desk_Centre", -5.60, -4.75, -0.95, 0.55, 0.75, "left")
swivel_chair("Prop_Chair_Centre", -6.100, -0.200, -0.30)
# The monitor the declared camera is notionally clipped to: its top front edge is at
# (-5.04, -0.20, 1.25) and the camera sits at (-4.97, -0.20, 1.30), just proud of it.
workstation("Prop_Camera_Monitor", 0.750, -0.200, -0.200, mon_cx=-5.130, kb_cx=-4.870)
# The two visible ones. y solved against the ROOM frame: the left panel's outer edge lands
# on +1.80, which is that frame's left edge at this depth.
workstation("Prop_Workstation_Left",  0.893,  1.525,  1.460)
workstation("Prop_Workstation_Right", 0.750, -1.620, -1.585)

# ── 5. asserts — the whole reason this file is re-runnable ────────────────────
bpy.context.view_layer.update()
FRONT_WALL, LEFT_WALL = 2.069, 2.366

def frame(eye_x, eye_y, eye_z, x):
    d = x - eye_x
    if d <= 0: return None
    return (eye_y - 0.75*d, eye_y + 0.75*d, eye_z - 0.4219*d, eye_z + 0.4219*d)

def ndc_room(bb):
    """For the report only. None when the object is behind the room eye — the formula
    sign-flips there, and a plausible-looking number for something behind the camera is
    worse than no number."""
    out = []
    for (x, y, z) in ((bb[3], bb[1], bb[2]), (bb[3], bb[4], bb[5])):
        d = x + 4.97
        out.append(None if d <= 0 else
                   [round((y + 0.20) / (0.75*d), 3), round((z - 1.30) / (0.4219*d), 3)])
    return out

WATCH = list(dict.fromkeys(log["created"] + [m["obj"] for m in log["moved"]]))
checks = []
for n in WATCH:
    o = sc.objects.get(n)
    if not o or o.type != 'MESH': continue
    bb = wbb(o)
    assert bb[3] < FRONT_WALL + 1e-3, "%s is past the front wall" % n
    assert bb[4] < LEFT_WALL + 1e-3,  "%s is through the left wall" % n
    # The SCREEN frustum is widest at the object's far end, so testing its y/z extent at
    # bb[3] is conservative for the whole object.
    f = frame(-2.508, -0.286, 1.42, bb[3])
    inside = bool(f) and not (bb[4] < f[0] or bb[1] > f[1] or bb[5] < f[2] or bb[2] > f[3])
    assert not inside, "%s is IN FRAME in the SCREEN push-in — the desks must not be" % n
    checks.append({"obj": n, "bb": [round(v, 3) for v in bb], "room_ndc": ndc_room(bb)})
    if n.startswith("Prop_Workstation") or n == "Prop_Camera_Monitor":
        mats = [m.name for m in o.data.materials]
        # ★ Screen_Glow is how initTVFocus decides a mesh is a telly. A fourth telly joins
        #   the box the push-in pose is solved from and re-frames the hero shot.
        assert "Screen_Glow" not in mats, "%s would become a fourth telly" % n
        assert len(o.data.materials) == 2, "%s: expected shell + glass" % n
log["checks"] = checks

# Nothing may end up standing inside anything else — the crates-inside-the-cabinet family.
ship = [o for o in props.all_objects if o.type == 'MESH' and not o.hide_render]
boxes = {o.name: wbb(o) for o in ship}
touched = set(WATCH)
clash = []
for n in sorted(touched & set(boxes)):
    a = boxes[n]
    for m, c in boxes.items():
        if m == n or m in touched: continue
        ov = [min(a[3], c[3]) - max(a[0], c[0]),
              min(a[4], c[4]) - max(a[1], c[1]),
              min(a[5], c[5]) - max(a[2], c[2])]
        if all(v > 0.02 for v in ov):
            vol = ov[0] * ov[1] * ov[2]
            if vol > 0.004:          # a flat rug underfoot is not a clash
                clash.append({"a": n, "b": m, "overlap_m3": round(vol, 4)})
log["clashes"] = clash
assert not clash, "objects standing inside each other: %s" % clash[:6]

with open(REPORT, "w") as f: json.dump(log, f, indent=1)
print("DESKS OK — %d created, %d moved, 0 clashes -> %s"
      % (len(log["created"]), len(log["moved"]), REPORT))
if log["warn"]: print("WARN:", log["warn"])
