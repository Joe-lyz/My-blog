import { deleteKVKey, ensureArray, internalError, json, methodNotAllowed, parseJsonBody, readKVJson, writeKVJson } from "../_lib/store.js";
import { deleteTripMedia } from "./travel-media.js";

const INDEX_KEY = "travel:index";
const ITEM_PREFIX = "travel:item:";
const MODES = new Set(["walk", "bike", "car", "bus", "train", "plane", "ship", "other"]);
const STATES = new Set(["person-a", "person-b", "together"]);
const STOP_TYPES = new Set(["start", "normal", "meetup", "transport-change", "destination"]);

function isIsoDate(value, required = false) {
  if (!value) return !required;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && !Number.isNaN(Date.parse(value));
}

function validateTrip(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Invalid JSON object";
  if (!String(input.title || "").trim()) return "title is required";
  if (!isIsoDate(input.startDate) || !isIsoDate(input.endDate)) return "Invalid date; use ISO 8601";
  if (input.startDate && input.endDate && Date.parse(input.startDate) > Date.parse(input.endDate)) return "startDate must not be after endDate";
  const stops = ensureArray(input.stops);
  const stopIds = new Set();
  for (const stop of stops) {
    if (!stop?.id || stopIds.has(stop.id)) return "Stop ids must be present and unique";
    stopIds.add(stop.id);
    if (!Number.isFinite(Number(stop.longitude)) || Number(stop.longitude) < -180 || Number(stop.longitude) > 180 || !Number.isFinite(Number(stop.latitude)) || Number(stop.latitude) < -90 || Number(stop.latitude) > 90) return "Invalid stop longitude or latitude";
    if (!isIsoDate(stop.arrivedAt) || !isIsoDate(stop.departedAt)) return "Invalid stop date; use ISO 8601";
    if (stop.stopType && !STOP_TYPES.has(stop.stopType)) return "Invalid stopType";
  }
  const segmentIds = new Set();
  for (const segment of ensureArray(input.segments)) {
    if (!segment?.id || segmentIds.has(segment.id)) return "Segment ids must be present and unique";
    segmentIds.add(segment.id);
    if (!stopIds.has(segment.fromStopId) || !stopIds.has(segment.toStopId)) return "Segment references an unknown stop";
    if (!MODES.has(segment.transportMode)) return "Invalid transportMode";
    if (!STATES.has(segment.travelerState)) return "Invalid travelerState";
    if (!isIsoDate(segment.startedAt) || !isIsoDate(segment.endedAt)) return "Invalid segment date; use ISO 8601";
    if (!Array.isArray(segment.coordinates) || segment.coordinates.length < 2 || segment.coordinates.some((point) => !Array.isArray(point) || point.length < 2 || !Number.isFinite(Number(point[0])) || Math.abs(Number(point[0])) > 180 || !Number.isFinite(Number(point[1])) || Math.abs(Number(point[1])) > 90)) return "Invalid segment coordinates";
  }
  return null;
}

function intersectsMonth(item, month) {
  if (!month) return true;
  const start = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(start.valueOf())) return false;
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const from = Date.parse(item.arrivedAt || item.startedAt || item.departedAt || item.endedAt || 0);
  const to = Date.parse(item.departedAt || item.endedAt || item.arrivedAt || item.startedAt || 0);
  return from < end.valueOf() && to >= start.valueOf();
}

function filterTrip(trip, month) {
  if (!month) return trip;
  return { ...trip, stops: ensureArray(trip.stops).filter((stop) => intersectsMonth(stop, month)), segments: ensureArray(trip.segments).filter((segment) => intersectsMonth(segment, month)) };
}

async function loadIndex(env) { return ensureArray(await readKVJson(env, INDEX_KEY, [])).map(String); }

async function seedDevelopmentTrip(env) {
  const index = await loadIndex(env);
  if (index.length || env?.ENVIRONMENT !== "development") return index;
  const id = crypto.randomUUID(), makeStop = (stopId, name, longitude, latitude, arrivedAt, stopType, participants, order) => ({ id: stopId, tripId:id, name, province:"", city:name, district:"", longitude, latitude, arrivedAt, departedAt:arrivedAt, stopType, participants, title:name, content:"开发环境示例旅行记录", coverUrl:"", media:[], tags:[], order });
  const stops=[makeStop("harbin","哈尔滨",126.63,45.75,"2026-07-01T08:00:00+08:00","start",["person-a"],0),makeStop("shanghai","上海",121.47,31.23,"2026-07-01T08:00:00+08:00","start",["person-b"],1),makeStop("beijing","北京",116.4,39.9,"2026-07-02T10:00:00+08:00","meetup",["person-a","person-b"],2),makeStop("xian","西安",108.94,34.34,"2026-07-03T14:00:00+08:00","transport-change",["person-a","person-b"],3),makeStop("chengdu","成都",104.07,30.67,"2026-07-05T18:00:00+08:00","destination",["person-a","person-b"],4)];
  const segment=(segmentId,a,b,travelerState,transportMode,order)=>({id:segmentId,tripId:id,fromStopId:a.id,toStopId:b.id,travelerState,transportMode,coordinates:[[a.longitude,a.latitude],[b.longitude,b.latitude]],startedAt:a.departedAt,endedAt:b.arrivedAt,order});
  const now=new Date().toISOString(),trip={id,title:"夏日见面旅行",slug:"summer-meetup",description:"两个人分别出发，在北京汇合，一起去往西安与成都。",coverUrl:"",startDate:"2026-07-01",endDate:"2026-07-05",travelers:[{id:"person-a",name:"小宁",avatarUrl:"/jn.png",color:"#b55b45",markerIcon:""},{id:"person-b",name:"小舟",avatarUrl:"/yz.png",color:"#547b8d",markerIcon:""}],stops,segments:[segment("harbin-beijing",stops[0],stops[2],"person-a","plane",0),segment("shanghai-beijing",stops[1],stops[2],"person-b","train",1),segment("beijing-xian",stops[2],stops[3],"together","train",2),segment("xian-chengdu",stops[3],stops[4],"together","car",3)],createdAt:now,updatedAt:now};
  await writeKVJson(env, ITEM_PREFIX+id, trip); await writeKVJson(env, INDEX_KEY,[id]); return [id];
}

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const month = url.searchParams.get("month");
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: "Invalid month; expected YYYY-MM", code: "INVALID_MONTH" }, 400);

    if (request.method === "GET") {
      await seedDevelopmentTrip(env);
      if (id) {
        const trip = await readKVJson(env, ITEM_PREFIX + id, null);
        return trip ? json(filterTrip(trip, month)) : json({ error: "Travel not found", code: "NOT_FOUND" }, 404);
      }
      const trips = [];
      for (const tripId of await loadIndex(env)) {
        const trip = await readKVJson(env, ITEM_PREFIX + tripId, null);
        if (!trip) continue;
        const filtered = filterTrip(trip, month);
        if (!month || filtered.stops.length || filtered.segments.length) trips.push(filtered);
      }
      return json(trips);
    }

    if (request.method === "POST" || request.method === "PUT") {
      const input = await parseJsonBody(request);
      if (!input) return json({ error: "Invalid JSON", code: "INVALID_JSON" }, 400);
      if (request.method === "PUT" && !input.id) return json({ error: "id is required", code: "ID_REQUIRED" }, 400);
      const error = validateTrip(input);
      if (error) return json({ error, code: "VALIDATION_ERROR" }, 400);
      const index = await loadIndex(env);
      const now = new Date().toISOString();
      const tripId = request.method === "POST" ? crypto.randomUUID() : String(input.id);
      if (request.method === "PUT" && !index.includes(tripId)) return json({ error: "Travel not found", code: "NOT_FOUND" }, 404);
      const previous = await readKVJson(env, ITEM_PREFIX + tripId, null);
      const trip = { ...input, id: tripId, slug: input.slug || tripId, travelers: ensureArray(input.travelers), stops: ensureArray(input.stops), segments: ensureArray(input.segments), createdAt: previous?.createdAt || now, updatedAt: now };
      await writeKVJson(env, ITEM_PREFIX + tripId, trip);
      if (!index.includes(tripId)) { index.push(tripId); await writeKVJson(env, INDEX_KEY, index); }
      return json(trip, request.method === "POST" ? 201 : 200);
    }

    if (request.method === "DELETE") {
      const body = await parseJsonBody(request);
      const tripId = String(body?.id || id || "");
      if (!tripId) return json({ error: "id is required", code: "ID_REQUIRED" }, 400);
      const index = await loadIndex(env);
      if (!index.includes(tripId)) return json({ error: "Travel not found", code: "NOT_FOUND" }, 404);
      await deleteTripMedia(env, tripId);
      await deleteKVKey(env, ITEM_PREFIX + tripId);
      await writeKVJson(env, INDEX_KEY, index.filter((item) => item !== tripId));
      return json({ success: true });
    }
    return methodNotAllowed();
  } catch (error) { return internalError(error); }
}
