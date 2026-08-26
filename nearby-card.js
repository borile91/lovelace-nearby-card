/*
 * Nearby Card — a Lovelace container that puts the cards for the room you are
 * in at the top of the stack.
 *
 * You give it cards, the way you would give them to vertical-stack. It reads
 * the entity out of each one, asks Home Assistant's registry which area that
 * entity belongs to, and reorders the stack so the current room comes first,
 * then the rest of the floor, then everything else.
 *
 * Two kinds of presence source, because one is rarely enough:
 *
 *   - AREA SENSOR — a single entity that reports which area you are in, such
 *     as Bermuda BLE Trilateration, ESPresense, or your own template sensor.
 *     Cheap: one sensor covers the whole house. Vague: it reports the area of
 *     the nearest receiver, which is not the room you are standing in when
 *     that room has no receiver. That is what `max_distance` is for — past
 *     that distance the room is dropped and only the floor is kept, because a
 *     wide answer that is true beats a precise one that is wrong.
 *
 *   - PER-AREA SENSORS — one binary sensor per room (mmWave, PIR, a plug that
 *     draws current, anything). Exact, but only for the rooms you cover. When
 *     several are on, the most recently triggered one wins: you were somewhere
 *     a minute ago, you are here now.
 *
 * `presence.priority` decides which source is asked first. Rooms neither
 * source can see stay unreachable — no amount of software invents a receiver
 * that is not there — so the header lets you say where you are by hand, for a
 * configurable number of minutes, after which it goes back to automatic.
 *
 * A card's area normally comes from its entity. Two escape hatches:
 * `nearby_area` on the card pins it to an area, and the `nearby` table lends a
 * card to another area — a window registered in the living room can sit right
 * next to the bathroom door, and from in there you want it within reach.
 *
 * https://github.com/borile91/lovelace-nearby-card
 * MIT — Copyright (c) 2026 Giacomo Borile
 */

(() => {
  "use strict";

  const CARD_TYPE = "nearby-card";
  const EDITOR_TAG = "nearby-card-editor";
  const VERSION = "1.2.0";

  const UNKNOWN = ["unknown", "unavailable", "none", "not_home", ""];

  const DEFAULT_LABELS = {
    here: "Here",
    rest_of_floor: "Rest of {floor}",
    elsewhere: "Elsewhere",
    no_floor: "Unassigned",
    away: "Away",
    away_note: "not reordering: listed by floor",
    at_home: "At home",
    in_room: "In {area}",
    on_floor: "On {floor}",
    room_unclear: "Room unclear: nearest receiver is {distance} away, in {area}",
    manual: "set by hand · back to automatic in {minutes} min",
    automatic: "Automatic",
    pick_room: "Say which room you are in",
    empty: "No cards yet. Add some in the editor.",
  };

  const DEFAULTS = {
    cards: [],
    presence: {
      /* area_sensor: { entity, area_attribute, floor_attribute,
                        distance_entity, max_distance } */
      area_sensor: null,
      /* area_sensors: [{ area, entity, state }] */
      area_sensors: [],
      priority: ["area_sensors", "area_sensor"],
      manual_minutes: 20,
    },
    /* cards that count as "here" on top of the ones whose area matches:
       [{ area: <area_id>, entities: [<entity_id>, ...] }] */
    nearby: [],
    grouping: "area_floor_rest",   /* area_floor_rest | area_rest | floor | none */
    sort: "config",                /* config | name */
    group_icons: false,            /* draw the area/floor icon beside the heading */
    header: {
      position: "top",             /* top | bottom | hidden */
      allow_manual: true,
    },
    labels: {},
  };

  const fill = (tpl, vars) =>
    String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : `{${k}}`));

  const isUnknown = (v) => v == null || UNKNOWN.includes(String(v).toLowerCase());

  /* Deep merge of plain objects, so a partial `presence:` block in YAML keeps
     the defaults it does not mention. */
  const merge = (base, over) => {
    if (!over || typeof over !== "object" || Array.isArray(over)) {
      return over === undefined ? base : over;
    }
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      out[k] = k in base && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])
        ? merge(base[k], v)
        : v;
    }
    return out;
  };

  /* First entity id mentioned anywhere in a card config. Covers `entity`,
     `entities: [...]` in all its shapes, and nested cards, so a stack or a
     mushroom template row still resolves to something. */
  const firstEntity = (conf, depth = 0) => {
    if (!conf || typeof conf !== "object" || depth > 4) return null;
    if (typeof conf.entity === "string" && conf.entity.includes(".")) return conf.entity;
    for (const key of ["entities", "cards", "features", "sections", "badges"]) {
      const list = conf[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item === "string" && item.includes(".")) return item;
        const found = firstEntity(item, depth + 1);
        if (found) return found;
      }
    }
    for (const key of ["card", "chip", "row"]) {
      const found = firstEntity(conf[key], depth + 1);
      if (found) return found;
    }
    return null;
  };

  const CSS = `
    :host { display: block; }
    ha-card { padding: 8px 10px 10px; }

    .where { display:flex; align-items:center; gap:10px; padding:4px 2px 8px; }
    .where.bottom { padding:10px 2px 2px; }
    .where ha-icon { --mdc-icon-size:26px; color:var(--primary-color); flex:none; }
    .where .text { min-width:0; flex:1; }
    .where .line1 { font-size:15px; font-weight:500; color:var(--primary-text-color);
                    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .where .line2 { font-size:12px; color:var(--secondary-text-color); margin-top:1px;
                    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .where.out ha-icon { color:var(--secondary-text-color); }
    .where .pick { flex:none; border:none; background:transparent; cursor:pointer;
                   padding:4px; border-radius:9px; line-height:0;
                   color:var(--secondary-text-color); }
    .where .pick ha-icon { --mdc-icon-size:20px; color:inherit; }
    .where .pick:hover { background:rgba(127,127,127,.18); }
    .where .pick.open { color:var(--primary-color); background:rgba(127,127,127,.14); }

    .rooms { display:none; flex-wrap:wrap; gap:5px; padding:0 0 8px; }
    .rooms.open { display:flex; }
    .rooms button { border:none; border-radius:13px; padding:5px 10px; font-size:12.5px;
                    cursor:pointer; color:var(--secondary-text-color);
                    background:var(--secondary-background-color, rgba(127,127,127,.14)); }
    .rooms button.on { background:var(--primary-color); color:var(--text-primary-color,#fff); }

    .group { margin-top:8px; }
    .group:first-child { margin-top:0; }
    .caption { display:flex; align-items:center; gap:5px;
               font-size:12.5px; font-weight:600; letter-spacing:.04em;
               text-transform:uppercase; color:var(--secondary-text-color);
               margin:0 2px 4px; }
    .caption span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .caption ha-icon { --mdc-icon-size:16px; width:16px; height:16px; flex:none;
                       color:inherit; }
    .caption.here { color:var(--primary-color); }
    .stack { display:flex; flex-direction:column; gap:6px; }

    .empty { font-size:13px; color:var(--secondary-text-color); padding:8px 2px; }
  `;

  class NearbyCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._hass = null;
      this._built = false;
      this._children = new Map();   /* index in config.cards -> <hui-card> */
      this._layout = "";            /* signature of the current order */
      this._watched = "";
      this._manual = null;          /* { area, until } */
      this._preview = false;
    }

    static getConfigElement() { return document.createElement(EDITOR_TAG); }

    static getStubConfig(hass, entities) {
      const first = (entities || []).slice(0, 3);
      return { cards: first.map((entity) => ({ type: "tile", entity })) };
    }

    setConfig(config) {
      if (!config || !Array.isArray(config.cards)) {
        throw new Error("nearby-card: `cards` must be a list of cards");
      }
      this._config = merge(DEFAULTS, config);
      this._labels = { ...DEFAULT_LABELS, ...(this._config.labels || {}) };
      /* the lent-card table is a list in YAML, because that is what the UI
         editor can build; inside it is handier as area -> Set of entities */
      this._lent = new Map();
      for (const row of this._config.nearby || []) {
        if (!row || !row.area) continue;
        const list = Array.isArray(row.entities) ? row.entities
          : row.entities ? [row.entities] : [];
        this._lent.set(row.area, new Set(list));
      }
      this._children.clear();
      this._layout = "";
      if (this._built) this.shadowRoot.querySelector(".body").replaceChildren();
    }

    set preview(v) {
      this._preview = v;
      for (const el of this._children.values()) el.preview = v;
    }
    get preview() { return this._preview; }

    /* Kept for masonry views; 1 unit is 50px. */
    async getCardSize() {
      let total = 1;
      for (const el of this._children.values()) {
        total += (typeof el.getCardSize === "function" ? await el.getCardSize() : 1) || 1;
      }
      return total;
    }

    getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (!this._built) this._build();
      for (const el of this._children.values()) el.hass = hass;

      const watched = this._signature();
      if (!first && watched === this._watched) return;
      this._watched = watched;
      this._render();
    }

    /* Only the things that can change the ORDER. The hass setter fires for
       every entity in the house, and the child cards redraw themselves. */
    _signature() {
      const p = this._config.presence;
      const bits = [];
      const add = (id) => {
        const s = id && this._hass.states[id];
        bits.push(`${id}=${s ? s.state : "-"}${s && s.last_changed ? "@" + s.last_changed : ""}`);
      };
      if (p.area_sensor && p.area_sensor.entity) {
        const s = this._hass.states[p.area_sensor.entity];
        const attrs = p.area_sensor;
        bits.push(`${p.area_sensor.entity}=${s ? s.state : "-"}`);
        if (s) {
          bits.push(String(s.attributes[attrs.area_attribute || "area_id"]));
          bits.push(String(s.attributes[attrs.floor_attribute || "floor_id"]));
        }
        if (p.area_sensor.distance_entity) add(p.area_sensor.distance_entity);
      }
      for (const s of p.area_sensors || []) add(s.entity);
      return bits.join("|");
    }

    _build() {
      this.shadowRoot.innerHTML = `<ha-card>
          <div class="where">
            <ha-icon></ha-icon>
            <div class="text"><div class="line1"></div><div class="line2"></div></div>
            <button class="pick" title="${DEFAULT_LABELS.pick_room}">
              <ha-icon icon="mdi:crosshairs-gps"></ha-icon></button>
          </div>
          <div class="rooms"></div>
          <div class="body"></div>
        </ha-card><style>${CSS}</style>`;
      this.shadowRoot.querySelector(".pick").addEventListener("click", () => {
        const rooms = this.shadowRoot.querySelector(".rooms");
        const open = !rooms.classList.contains("open");
        rooms.classList.toggle("open", open);
        this.shadowRoot.querySelector(".pick").classList.toggle("open", open);
        if (open) this._renderRooms();
      });
      this._built = true;
    }

    /* ---- registry lookups ------------------------------------------- */
    _areaOfEntity(entityId) {
      const h = this._hass;
      const e = h.entities && h.entities[entityId];
      if (!e) return null;
      if (e.area_id) return e.area_id;
      const d = e.device_id && h.devices && h.devices[e.device_id];
      return d ? d.area_id || null : null;
    }
    _areaName(areaId) {
      const a = this._hass.areas && this._hass.areas[areaId];
      return a ? a.name : areaId;
    }
    _floorOfArea(areaId) {
      const a = this._hass.areas && this._hass.areas[areaId];
      return a ? a.floor_id || null : null;
    }
    _floorName(floorId) {
      const f = this._hass.floors && this._hass.floors[floorId];
      return f ? f.name : floorId;
    }
    _floorLevel(floorId) {
      const f = this._hass.floors && this._hass.floors[floorId];
      return f && f.level != null ? f.level : 99;
    }
    _areaIcon(areaId) {
      const a = this._hass.areas && this._hass.areas[areaId];
      /* mdi:texture-box is what Home Assistant shows for an area with no icon
         of its own, so an area without one still looks like an area */
      return a ? a.icon || "mdi:texture-box" : null;
    }
    /* Same fallback the frontend uses when a floor has no icon: the storey
       number, or a plain house when there is no level to draw. */
    _floorIcon(floorId) {
      const f = this._hass.floors && this._hass.floors[floorId];
      if (!f) return null;
      if (f.icon) return f.icon;
      const level = f.level;
      if (level == null) return "mdi:home-outline";
      if (level < 0) return "mdi:home-floor-negative-1";
      if (level > 3) return "mdi:home-outline";
      return `mdi:home-floor-${level}`;
    }

    /* ---- where am I -------------------------------------------------- */
    _presence() {
      const L = this._labels;

      if (this._manual && this._manual.until > Date.now()) {
        const left = Math.max(1, Math.round((this._manual.until - Date.now()) / 60000));
        return {
          home: true, manual: true, icon: "mdi:gesture-tap",
          area: this._manual.area, floor: this._floorOfArea(this._manual.area),
          title: fill(L.in_room, { area: this._areaName(this._manual.area) }),
          note: fill(L.manual, { minutes: left }),
        };
      }

      for (const source of this._config.presence.priority) {
        const got = source === "area_sensors" ? this._fromRoomSensors() : this._fromAreaSensor();
        if (got) return got;
      }
      return {
        home: false, icon: "mdi:home-export-outline", area: null, floor: null,
        title: L.away, note: L.away_note,
      };
    }

    /* Per-room binary sensors. Several on at once means you walked through:
       the most recently triggered one is where you are now. */
    _fromRoomSensors() {
      const list = this._config.presence.area_sensors || [];
      let best = null;
      for (const item of list) {
        if (!item || !item.entity || !item.area) continue;
        const s = this._hass.states[item.entity];
        if (!s) continue;
        const wanted = item.state || "on";
        if (String(s.state).toLowerCase() !== String(wanted).toLowerCase()) continue;
        const when = Date.parse(s.last_changed || 0) || 0;
        if (!best || when > best.when) best = { area: item.area, when, entity: item.entity };
      }
      if (!best) return null;
      const L = this._labels;
      return {
        home: true, icon: "mdi:motion-sensor",
        area: best.area, floor: this._floorOfArea(best.area),
        title: fill(L.in_room, { area: this._areaName(best.area) }),
        note: this._hass.states[best.entity].attributes.friendly_name || best.entity,
      };
    }

    /* Single sensor that reports an area (Bermuda, ESPresense, template). */
    _fromAreaSensor() {
      const cfg = this._config.presence.area_sensor;
      if (!cfg || !cfg.entity) return null;
      const s = this._hass.states[cfg.entity];
      if (!s || isUnknown(s.state)) return null;

      const L = this._labels;
      const areaAttr = cfg.area_attribute || "area_id";
      const floorAttr = cfg.floor_attribute || "floor_id";
      let area = s.attributes[areaAttr] || null;
      let floor = s.attributes[floorAttr] || null;

      /* Sensors that put the area in the state instead of an attribute: match
         it against the registry, by id and by name. */
      if (!area) {
        const wanted = String(s.state).toLowerCase();
        for (const [id, a] of Object.entries(this._hass.areas || {})) {
          if (id.toLowerCase() === wanted || String(a.name).toLowerCase() === wanted) {
            area = id;
            break;
          }
        }
      }
      if (!floor && area) floor = this._floorOfArea(area);
      if (!area && !floor) return null;

      const source = s.attributes.friendly_name || cfg.entity;
      const dEnt = cfg.distance_entity && this._hass.states[cfg.distance_entity];
      const distance = dEnt && !isUnknown(dEnt.state) ? Number(dEnt.state) : null;
      const unit = (dEnt && dEnt.attributes.unit_of_measurement) || "m";
      const tooFar = cfg.max_distance != null && distance != null &&
        isFinite(distance) && distance > Number(cfg.max_distance);

      if (tooFar) {
        return {
          home: true, icon: "mdi:map-marker-question", area: null, floor,
          title: floor ? fill(L.on_floor, { floor: this._floorName(floor) }) : L.at_home,
          note: fill(L.room_unclear, {
            distance: `${distance} ${unit}`,
            area: area ? this._areaName(area) : s.state,
          }),
        };
      }
      return {
        home: true, icon: "mdi:map-marker-account", area, floor,
        title: area ? fill(L.in_room, { area: this._areaName(area) })
                    : fill(L.on_floor, { floor: this._floorName(floor) }),
        note: distance != null && isFinite(distance)
          ? `${source} · ${distance} ${unit}` : source,
      };
    }

    /* ---- grouping ---------------------------------------------------- */
    _items() {
      const cards = this._config.cards || [];
      const items = cards.map((conf, index) => {
        const entity = firstEntity(conf);
        const area = conf.nearby_area || (entity ? this._areaOfEntity(entity) : null);
        const state = entity && this._hass.states[entity];
        return {
          index, conf, entity, area,
          floor: area ? this._floorOfArea(area) : null,
          name: conf.name || (state && state.attributes.friendly_name) || entity || "",
        };
      });
      if (this._config.sort === "name") {
        items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      }
      return items;
    }

    _groups(where, items) {
      const L = this._labels;
      /* by floor, whatever the room: the floor you are on comes first, the
         others below it in the order the stairs go */
      if (this._config.grouping === "floor") return this._byFloor(items, where.floor, true);
      if (this._config.grouping === "none" || (!where.area && !where.floor)) {
        if (this._config.grouping === "none") return [{ key: "all", cards: items }];
        return this._byFloor(items);
      }

      const lent = (where.area && this._lent.get(where.area)) || new Set();
      const here = [], floor = [], rest = [];
      for (const it of items) {
        if (where.area && (it.area === where.area || lent.has(it.entity))) here.push(it);
        else if (where.floor && it.floor === where.floor &&
                 this._config.grouping === "area_floor_rest") floor.push(it);
        else rest.push(it);
      }

      const out = [];
      if (here.length) {
        out.push({
          key: "here", here: true, icon: this._areaIcon(where.area),
          title: this._areaName(where.area) || L.here, cards: here,
        });
      }
      if (floor.length) {
        out.push({
          key: "floor", icon: this._floorIcon(where.floor),
          title: here.length
            ? fill(L.rest_of_floor, { floor: this._floorName(where.floor) })
            : this._floorName(where.floor),
          cards: floor,
        });
      }
      if (rest.length) {
        out.push({ key: "rest", title: out.length ? L.elsewhere : null, cards: rest });
      }
      return out;
    }

    /* One group per floor, bottom one first. `here` is the floor you are on,
       which jumps to the top; `always` keeps the headings even when there is
       only one floor to show, which is what someone asking for grouping by
       floor means, as opposed to falling back to it because nothing else is
       known. */
    _byFloor(items, here = null, always = false) {
      const perFloor = new Map();
      for (const it of items) {
        const k = it.floor || "_";
        if (!perFloor.has(k)) perFloor.set(k, []);
        perFloor.get(k).push(it);
      }
      if (!always && perFloor.size < 2) return [{ key: "all", cards: items }];
      return [...perFloor.keys()]
        .sort((a, b) => {
          if (a === b) return 0;
          if (a === here) return -1;
          if (b === here) return 1;
          return this._floorLevel(a) - this._floorLevel(b);
        })
        .map((k) => ({
          key: `floor_${k}`,
          here: k === here,
          icon: k === "_" ? null : this._floorIcon(k),
          title: k === "_" ? this._labels.no_floor : this._floorName(k),
          cards: perFloor.get(k),
        }));
    }

    /* ---- drawing ------------------------------------------------------ */
    _render() {
      const where = this._presence();
      const groups = this._groups(where, this._items());
      this._header(where);

      const layout = groups.map((g) => `${g.key}:${g.cards.map((c) => c.index).join(",")}`).join("|");
      if (layout !== this._layout) {
        this._layout = layout;
        this._drawGroups(groups);
      }

      clearTimeout(this._alarm);
      if (this._manual && this._manual.until > Date.now()) {
        this._alarm = setTimeout(() => {
          this._watched = ""; this._layout = ""; this._render();
        }, this._manual.until - Date.now() + 500);
      }
    }

    _header(where) {
      const r = this.shadowRoot;
      const box = r.querySelector(".where");
      const pos = this._config.header.position;
      const hidden = pos === "hidden";
      box.style.display = hidden ? "none" : "";
      r.querySelector(".rooms").style.display = hidden ? "none" : "";
      if (hidden) return;

      box.classList.toggle("out", !where.home);
      box.classList.toggle("bottom", pos === "bottom");
      box.querySelector("ha-icon").setAttribute("icon", where.icon);
      box.querySelector(".line1").textContent = where.title;
      box.querySelector(".line2").textContent = where.note;
      box.querySelector(".pick").style.display = this._config.header.allow_manual ? "" : "none";
      if (r.querySelector(".rooms").classList.contains("open")) this._renderRooms();

      /* header at the bottom: the same nodes, moved after the body */
      const card = r.querySelector("ha-card");
      const body = r.querySelector(".body");
      const rooms = r.querySelector(".rooms");
      const wantBottom = pos === "bottom";
      const isBottom = card.firstElementChild === body;
      if (wantBottom !== isBottom) {
        if (wantBottom) {
          card.append(box, rooms);
        } else {
          card.insertBefore(box, body);
          card.insertBefore(rooms, body);
        }
      }
    }

    /* Rooms to choose from: every area used by a card, plus the ones that only
       lend cards to others. */
    _renderRooms() {
      const box = this.shadowRoot.querySelector(".rooms");
      const areas = new Set(this._items().map((i) => i.area).filter(Boolean));
      for (const a of this._lent.keys()) areas.add(a);

      const ordered = [...areas].sort((a, b) =>
        this._floorLevel(this._floorOfArea(a)) - this._floorLevel(this._floorOfArea(b)) ||
        String(this._areaName(a)).localeCompare(String(this._areaName(b))));

      const active = this._manual && this._manual.until > Date.now() ? this._manual.area : null;
      box.replaceChildren();
      const chip = (text, area) => {
        const b = document.createElement("button");
        b.textContent = text;
        b.classList.toggle("on", area === active);
        b.addEventListener("click", () => {
          this._manual = area
            ? { area, until: Date.now() + this._config.presence.manual_minutes * 60000 }
            : null;
          box.classList.remove("open");
          this.shadowRoot.querySelector(".pick").classList.remove("open");
          this._watched = ""; this._layout = "";
          this._render();
        });
        box.appendChild(b);
      };
      chip(this._labels.automatic, null);
      for (const a of ordered) chip(this._areaName(a), a);
    }

    _drawGroups(groups) {
      const body = this.shadowRoot.querySelector(".body");
      body.replaceChildren();
      if (!groups.length || !groups.some((g) => g.cards.length)) {
        const p = document.createElement("div");
        p.className = "empty";
        p.textContent = this._labels.empty;
        body.appendChild(p);
        return;
      }
      for (const g of groups) {
        const div = document.createElement("div");
        div.className = "group";
        if (g.title) {
          const cap = document.createElement("div");
          cap.className = "caption" + (g.here ? " here" : "");
          if (this._config.group_icons && g.icon) {
            const icon = document.createElement("ha-icon");
            icon.setAttribute("icon", g.icon);
            cap.appendChild(icon);
          }
          const text = document.createElement("span");
          text.textContent = g.title;
          cap.appendChild(text);
          div.appendChild(cap);
        }
        const stack = document.createElement("div");
        stack.className = "stack";
        for (const item of g.cards) stack.appendChild(this._child(item));
        div.appendChild(stack);
        body.appendChild(div);
      }
    }

    /* One <hui-card> per configured card, created once and moved around as the
       order changes: rebuilding them on every move would restart animations
       and drop anything the user is holding, like a slider. */
    _child(item) {
      let el = this._children.get(item.index);
      if (!el) {
        el = document.createElement("hui-card");
        const conf = { ...item.conf };
        delete conf.nearby_area;      /* ours, not the child's */
        el.config = conf;
        el.hass = this._hass;
        el.preview = this._preview;
        /* hui-card is lazy-loaded: if it has not been defined yet the element
           upgrades later, and load() only exists from that moment on */
        if (typeof el.load === "function") el.load();
        else customElements.whenDefined("hui-card").then(() => el.load && el.load());
        this._children.set(item.index, el);
      }
      return el;
    }
  }

  /* ==================================================================== */

  const FORM_SCHEMA = () => [
    {
      name: "presence", type: "expandable", flatten: true, expanded: true,
      icon: "mdi:map-marker-account", title: "Presence",
      schema: [
        {
          name: "area_sensor", type: "expandable", flatten: false,
          icon: "mdi:bluetooth", title: "Area sensor (Bermuda, ESPresense, template)",
          schema: [
            { name: "entity", selector: { entity: {} } },
            {
              /* no `default:` anywhere in this schema on purpose: ha-form
                 fires value-changed when it fills a default in, which comes
                 straight back as a config change and starts a loop. The
                 defaults live in the card instead. */
              type: "grid", name: "", schema: [
                { name: "area_attribute", selector: { text: {} } },
                { name: "floor_attribute", selector: { text: {} } },
              ],
            },
            { name: "distance_entity", selector: { entity: { filter: [{ device_class: "distance" }] } } },
            { name: "max_distance", selector: { number: { min: 0, max: 50, step: 0.5, mode: "box", unit_of_measurement: "m" } } },
          ],
        },
        {
          type: "grid", name: "", schema: [
            { name: "priority", selector: { select: { mode: "dropdown", options: [
              { value: "area_sensors,area_sensor", label: "Room sensors first" },
              { value: "area_sensor,area_sensors", label: "Area sensor first" },
            ] } } },
            { name: "manual_minutes", selector: { number: { min: 1, max: 240, step: 1, mode: "box", unit_of_measurement: "min" } } },
          ],
        },
        {
          name: "area_sensors", selector: {
            object: {
              multiple: true,
              label_field: "area",
              description_field: "entity",
              fields: {
                area: { label: "Area", required: true, selector: { area: {} } },
                entity: { label: "Sensor", required: true, selector: { entity: { filter: [{ domain: "binary_sensor" }, { domain: "sensor" }, { domain: "input_boolean" }] } } },
                state: { label: "Counts as present when state is", selector: { text: {} } },
              },
            },
          },
        },
      ],
    },
    {
      name: "nearby", type: "expandable", flatten: true,
      icon: "mdi:arrow-expand-horizontal", title: "Cards lent to a nearby room",
      schema: [
        {
          name: "nearby", selector: {
            object: {
              multiple: true,
              label_field: "area",
              description_field: "entities",
              fields: {
                area: { label: "When I am in", required: true, selector: { area: {} } },
                entities: { label: "Also show these", required: true, selector: { entity: { multiple: true } } },
              },
            },
          },
        },
      ],
    },
    {
      name: "layout", type: "expandable", flatten: true, icon: "mdi:view-agenda", title: "Layout",
      schema: [
        {
          type: "grid", name: "", schema: [
            { name: "grouping", selector: { select: { mode: "dropdown", options: [
              { value: "area_floor_rest", label: "Room, rest of floor, elsewhere" },
              { value: "area_rest", label: "Room, everything else" },
              { value: "floor", label: "By floor, yours first" },
              { value: "none", label: "One list, no headings" },
            ] } } },
            { name: "sort", selector: { select: { mode: "dropdown", options: [
              { value: "config", label: "As configured" },
              { value: "name", label: "By name" },
            ] } } },
            { name: "header_position", selector: { select: { mode: "dropdown", options: [
              { value: "top", label: "Position on top" },
              { value: "bottom", label: "Position at the bottom" },
              { value: "hidden", label: "Hide position" },
            ] } } },
            { name: "header_allow_manual", selector: { boolean: {} } },
            { name: "group_icons", selector: { boolean: {} } },
          ],
        },
      ],
    },
  ];

  const FORM_LABELS = {
    entity: "Entity",
    area_attribute: "Area attribute",
    floor_attribute: "Floor attribute",
    distance_entity: "Distance entity",
    max_distance: "Drop the room past",
    priority: "Ask first",
    manual_minutes: "Manual choice lasts",
    area_sensors: "Per-room presence sensors",
    grouping: "Grouping",
    sort: "Default order",
    header_position: "Position indicator",
    header_allow_manual: "Let me set the room by hand",
    group_icons: "Icon beside each heading",
  };

  const FORM_HELPERS = {
    max_distance: "Past this distance from the nearest receiver the room is dropped and only the floor is kept. Leave empty to always trust the room.",
    area_attribute: "Attribute holding the area id. If the sensor puts the area in its state instead, leave the attribute empty.",
    area_sensors: "One sensor per room. When several are on, the most recent one wins.",
    nearby: "A card belongs to the area of its entity. Here you can lend it to another room as well — a window registered in the living room that sits right by the bathroom door.",
    group_icons: "The area or floor icon from Home Assistant. Floors without one fall back to their storey number.",
  };

  class NearbyCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._config = { cards: [] };
      this._selected = 0;
      this._guiMode = true;
      this._built = false;
    }

    setConfig(config) {
      this._config = { cards: [], ...config };
      if (this._selected > this._config.cards.length) this._selected = this._config.cards.length;
      this._sync();
    }

    /* hass arrives on every state change in the house — hundreds of times a
       minute. It must never rebuild anything: it hands the new object to the
       children that already exist and stops there. Rebuilding here is what
       froze the browser tab: a fresh child editor announces its config, which
       comes back as a config change, which rebuilds again. */
    set hass(hass) {
      this._hass = hass;
      this._boot();
      if (!this._built) { this._sync(); return; }
      for (const el of this._children()) el.hass = hass;
    }

    set lovelace(lovelace) {
      this._lovelace = lovelace;
      for (const el of this._children()) el.lovelace = lovelace;
    }

    _children() {
      if (!this._built) return [];
      return [this._form, this._cardEditor, this._picker].filter(Boolean);
    }

    /* hui-card-element-editor and hui-card-picker are lazy-loaded by the
       frontend and are not there until some built-in stack editor has been
       opened at least once. Opening one on the quiet defines both. */
    async _boot() {
      if (this._booted) return;
      this._booted = true;
      try {
        if (!customElements.get("hui-card-element-editor")) {
          const helpers = await window.loadCardHelpers();
          helpers.createCardElement({ type: "vertical-stack", cards: [] });
          await customElements.whenDefined("hui-vertical-stack-card");
          const cls = customElements.get("hui-vertical-stack-card");
          if (cls && cls.getConfigElement) await cls.getConfigElement();
          await customElements.whenDefined("hui-card-element-editor");
        }
      } catch (err) {
        /* the editor still works, minus the card picker */
        console.warn("nearby-card: could not preload the card editor", err);
      }
      this._sync();
    }

    /* A config that says the same thing as the one we already have is not
       worth announcing, and announcing it is exactly how a loop starts: the
       dashboard hands it back through setConfig, which refreshes the form,
       which announces it again. */
    _emit(config) {
      if (JSON.stringify(config) === JSON.stringify(this._config)) return;
      this._config = config;
      this.dispatchEvent(new CustomEvent("config-changed", {
        detail: { config }, bubbles: true, composed: true,
      }));
      this._sync();
    }

    /* The form holds everything except the cards; the nested shape of the
       config is flattened here and folded back on the way out, because
       ha-form works on a flat object. */
    _formData() {
      const c = this._config;
      const p = c.presence || {};
      return {
        area_sensor: p.area_sensor || {},
        area_sensors: p.area_sensors || [],
        priority: (p.priority || DEFAULTS.presence.priority).join(","),
        manual_minutes: p.manual_minutes ?? DEFAULTS.presence.manual_minutes,
        nearby: c.nearby || [],
        grouping: c.grouping ?? DEFAULTS.grouping,
        sort: c.sort ?? DEFAULTS.sort,
        group_icons: c.group_icons ?? DEFAULTS.group_icons,
        header_position: (c.header && c.header.position) ?? DEFAULTS.header.position,
        header_allow_manual: (c.header && c.header.allow_manual) ?? DEFAULTS.header.allow_manual,
      };
    }

    _fromForm(v) {
      const out = { ...this._config };
      const areaSensor = v.area_sensor && v.area_sensor.entity ? v.area_sensor : null;
      out.presence = {
        ...(this._config.presence || {}),
        area_sensor: areaSensor,
        area_sensors: v.area_sensors && v.area_sensors.length ? v.area_sensors : undefined,
        priority: v.priority ? v.priority.split(",") : undefined,
        manual_minutes: v.manual_minutes,
      };
      for (const k of Object.keys(out.presence)) {
        if (out.presence[k] === undefined || out.presence[k] === null) delete out.presence[k];
      }
      if (!Object.keys(out.presence).length) delete out.presence;
      if (v.nearby && v.nearby.length) out.nearby = v.nearby;
      else delete out.nearby;
      out.grouping = v.grouping;
      out.sort = v.sort;
      out.group_icons = v.group_icons;
      out.header = { position: v.header_position, allow_manual: v.header_allow_manual };
      return out;
    }

    /* Everything below only ever updates what changed. The DOM is built once
       in _build(); the child editors live as long as this editor does. */
    _sync() {
      if (!this._hass) return;
      /* Belt and braces. Every known way of looping is closed off above, but
         an editor that spins is a tab the browser cannot recover from, and
         the frontend is free to change its mind about when it fires events.
         Fifty updates in a second is nothing a person can produce. */
      const now = Date.now();
      if (now - (this._burstStart || 0) > 1000) { this._burstStart = now; this._burst = 0; }
      if (++this._burst > 50) {
        if (!this._warned) {
          this._warned = true;
          console.warn("nearby-card: editor updating far too often, stopping to keep the tab alive");
        }
        return;
      }
      if (!this._built) this._build();
      this._syncTabs();
      this._syncSlot();
      this._syncForm();
    }

    _build() {
      this.shadowRoot.innerHTML = `
        <div class="tabs"></div>
        <div class="slot">
          <div class="toolbar"></div>
          <div class="holder"></div>
          <div class="hint">Cards are grouped by the area of their entity. Add
            <code>nearby_area: &lt;area id&gt;</code> to a card to pin it to another room.</div>
        </div>
        <div class="form"></div>
        <style>
          .tabs { display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin-bottom:8px; }
          .tabs button { border:none; border-radius:12px; padding:5px 11px; font-size:13px;
                         cursor:pointer; color:var(--secondary-text-color);
                         background:var(--secondary-background-color, rgba(127,127,127,.14)); }
          .tabs button.on { background:var(--primary-color); color:var(--text-primary-color,#fff); }
          .toolbar { display:flex; gap:4px; margin:2px 0 6px; }
          .toolbar ha-icon-button { --mdc-icon-button-size:36px; }
          .slot { margin-bottom:12px; }
          .hint { font-size:12px; color:var(--secondary-text-color); margin:8px 2px 0; }
          .hint code { font-size:11.5px; }
        </style>`;

      const bar = this.shadowRoot.querySelector(".toolbar");
      const tool = (icon, title, fn) => {
        const b = document.createElement("ha-icon-button");
        b.title = title;
        b.innerHTML = `<ha-icon icon="${icon}"></ha-icon>`;
        b.addEventListener("click", fn);
        bar.appendChild(b);
      };
      const move = (delta) => {
        const cards = [...this._config.cards];
        const to = this._selected + delta;
        if (to < 0 || to >= cards.length) return;
        [cards[this._selected], cards[to]] = [cards[to], cards[this._selected]];
        this._selected = to;
        this._emit({ ...this._config, cards });
      };
      tool("mdi:arrow-up", "Move up", () => move(-1));
      tool("mdi:arrow-down", "Move down", () => move(1));
      tool("mdi:delete", "Remove", () => {
        const cards = this._config.cards.filter((_, i) => i !== this._selected);
        this._selected = Math.max(0, this._selected - 1);
        this._emit({ ...this._config, cards });
      });

      const holder = this.shadowRoot.querySelector(".holder");

      this._cardEditor = document.createElement("hui-card-element-editor");
      this._cardEditor.hass = this._hass;
      this._cardEditor.lovelace = this._lovelace;
      this._cardEditor.addEventListener("config-changed", (ev) => {
        ev.stopPropagation();
        if (this._applying) return;      /* our own value landing, not a user edit */
        const cards = [...this._config.cards];
        cards[this._selected] = ev.detail.config;
        this._emit({ ...this._config, cards });
      });
      this._cardEditor.addEventListener("GUImode-changed", (ev) => {
        ev.stopPropagation();
        this._guiMode = ev.detail.guiMode;
      });
      holder.appendChild(this._cardEditor);

      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => FORM_LABELS[s.name] || undefined;
      this._form.computeHelper = (s) => FORM_HELPERS[s.name] || undefined;
      this._form.hass = this._hass;
      this._form.schema = FORM_SCHEMA();
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        if (this._applying) return;
        this._emit(this._fromForm(ev.detail.value));
      });
      this.shadowRoot.querySelector(".form").appendChild(this._form);

      this._built = true;
    }

    _syncTabs() {
      const tabs = this.shadowRoot.querySelector(".tabs");
      const n = this._config.cards.length;
      const want = `${n}/${this._selected}`;
      if (tabs.dataset.state === want) return;
      tabs.dataset.state = want;

      tabs.replaceChildren();
      const tab = (text, index, title) => {
        const b = document.createElement("button");
        b.textContent = text;
        if (title) b.title = title;
        b.classList.toggle("on", index === this._selected);
        b.addEventListener("click", () => { this._selected = index; this._sync(); });
        tabs.appendChild(b);
      };
      for (let i = 0; i < n; i++) tab(String(i + 1), i);
      tab("+", n, "Add card");
    }

    /* The card picker draws a live preview of every card type there is. That
       is a lot of work to do for something behind a "+" nobody has pressed
       yet, so it is built the first time it is actually asked for. */
    _ensurePicker() {
      if (this._picker) return this._picker;
      this._picker = document.createElement("hui-card-picker");
      this._picker.hass = this._hass;
      this._picker.lovelace = this._lovelace;
      this._picker.addEventListener("config-changed", (ev) => {
        ev.stopPropagation();
        if (this._applying) return;
        const cards = [...this._config.cards, ev.detail.config];
        this._selected = cards.length - 1;
        this._emit({ ...this._config, cards });
      });
      this.shadowRoot.querySelector(".holder").appendChild(this._picker);
      return this._picker;
    }

    _syncSlot() {
      const adding = this._selected >= this._config.cards.length;
      this.shadowRoot.querySelector(".toolbar").style.display = adding ? "none" : "";
      this.shadowRoot.querySelector(".hint").style.display = adding ? "none" : "";
      this._cardEditor.style.display = adding ? "none" : "";
      if (adding) this._ensurePicker().style.display = "";
      else if (this._picker) this._picker.style.display = "none";
      if (adding) return;

      const value = this._config.cards[this._selected];
      if (JSON.stringify(this._cardEditor.value) === JSON.stringify(value)) return;
      this._applying = true;
      this._cardEditor.value = value;
      this._applying = false;
    }

    _syncForm() {
      const data = this._formData();
      if (JSON.stringify(this._form.data) === JSON.stringify(data)) return;
      this._applying = true;
      this._form.data = data;
      this._applying = false;
    }
  }

  if (!customElements.get(CARD_TYPE)) customElements.define(CARD_TYPE, NearbyCard);
  if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, NearbyCardEditor);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: CARD_TYPE,
    name: "Nearby Card",
    description: "A container that moves the cards for the room you are in to the top.",
    preview: false,
    documentationURL: "https://github.com/borile91/lovelace-nearby-card",
  });

  console.info(
    `%c NEARBY-CARD %c ${VERSION} `,
    "color:#fff;background:#03a9f4;font-weight:700",
    "color:#03a9f4;background:#fff;font-weight:700"
  );
})();
