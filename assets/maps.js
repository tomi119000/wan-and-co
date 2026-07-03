/* ===========================================================
   Wan & Co. — unified map wrapper
   -----------------------------------------------------------
   ひとつの API で Google Maps と Leaflet を切り替えます。
   config.js に GOOGLE_MAPS_API_KEY があれば Google Maps を、
   なければ Leaflet(OpenStreetMap) を自動で使用します。

   使い方:
     await WCMap.ready();
     const m = WCMap.create("map", { center:{lat,lng}, zoom, interactive:true });
     m.addMarker({lat,lng}, { title, html, onClick });
     m.clearMarkers();
     m.setView({lat,lng}, zoom);
     m.onClick(fn);                 // fn({lat,lng})
     m.setYou({lat,lng});           // 現在地マーカー
     WCMap.provider  -> "google" | "leaflet"
   =========================================================== */
(function () {
  const cfg = window.WC_CONFIG || {};
  const key = (cfg.GOOGLE_MAPS_API_KEY || "").trim();
  const useGoogle = key.length > 0;

  const PIN = "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="46" viewBox="0 0 34 46">
       <path d="M17 0C7.6 0 0 7.6 0 17c0 12 17 29 17 29s17-17 17-29C34 7.6 26.4 0 17 0z" fill="#b48b46"/>
       <circle cx="17" cy="17" r="7" fill="#fff"/>
     </svg>`);

  let readyResolve;
  const readyPromise = new Promise(r => (readyResolve = r));

  const WCMap = {
    provider: useGoogle ? "google" : "leaflet",
    ready: () => readyPromise,
    create: null, // set below once provider loads
  };
  window.WCMap = WCMap;

  /* ---------------- Google Maps backend ---------------- */
  function initGoogle() {
    WCMap.create = function (elId, opts = {}) {
      const el = document.getElementById(elId);
      const map = new google.maps.Map(el, {
        center: opts.center || cfg.DEFAULT_CENTER,
        zoom: opts.zoom || cfg.DEFAULT_ZOOM,
        disableDefaultUI: opts.interactive === false,
        zoomControl: opts.interactive !== false,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        gestureHandling: opts.interactive === false ? "none" : "greedy",
        styles: GOOGLE_STYLE,
      });
      let markers = [], info = new google.maps.InfoWindow(), you = null;
      return {
        raw: map,
        addMarker(pos, o = {}) {
          const mk = new google.maps.Marker({
            position: pos, map, title: o.title || "",
            icon: { url: PIN, scaledSize: new google.maps.Size(34, 46), anchor: new google.maps.Point(17, 46) },
          });
          if (o.html) mk.addListener("click", () => { info.setContent(o.html); info.open(map, mk); });
          if (o.onClick) mk.addListener("click", o.onClick);
          markers.push(mk); return mk;
        },
        clearMarkers() { markers.forEach(m => m.setMap(null)); markers = []; },
        setView(pos, zoom) { map.setCenter(pos); if (zoom) map.setZoom(zoom); },
        onClick(fn) { map.addListener("click", e => fn({ lat: e.latLng.lat(), lng: e.latLng.lng() })); },
        setYou(pos) {
          if (you) you.setMap(null);
          you = new google.maps.Marker({
            position: pos, map, title: "現在地",
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: "#caa45f", fillOpacity: 1, strokeColor: "#b48b46", strokeWeight: 3 },
          });
        },
      };
    };
    readyResolve();
  }

  /* Google Maps needs a global callback */
  window.__wcGmapsReady = initGoogle;

  function loadGoogle() {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__wcGmapsReady&libraries=places&language=ja&region=JP`;
    s.async = true;
    s.onerror = () => { console.warn("Google Maps の読み込みに失敗しました。Leaflet にフォールバックします。"); loadLeaflet(); };
    document.head.appendChild(s);
  }

  /* ---------------- Leaflet backend ---------------- */
  function initLeaflet() {
    const icon = L.icon({ iconUrl: PIN, iconSize: [34, 46], iconAnchor: [17, 46], popupAnchor: [0, -40] });
    WCMap.provider = "leaflet";
    WCMap.create = function (elId, opts = {}) {
      const interactive = opts.interactive !== false;
      const map = L.map(elId, {
        zoomControl: false, dragging: interactive, scrollWheelZoom: interactive,
        doubleClickZoom: interactive, boxZoom: interactive, keyboard: interactive, tap: interactive,
      }).setView([(opts.center || cfg.DEFAULT_CENTER).lat, (opts.center || cfg.DEFAULT_CENTER).lng], opts.zoom || cfg.DEFAULT_ZOOM);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
      if (interactive) L.control.zoom({ position: "topright" }).addTo(map);
      let markers = [], you = null;
      return {
        raw: map,
        addMarker(pos, o = {}) {
          const mk = L.marker([pos.lat, pos.lng], { icon }).addTo(map);
          if (o.html) mk.bindPopup(o.html);
          if (o.onClick) mk.on("click", o.onClick);
          markers.push(mk); return mk;
        },
        clearMarkers() { markers.forEach(m => map.removeLayer(m)); markers = []; },
        setView(pos, zoom) { map.setView([pos.lat, pos.lng], zoom || map.getZoom()); },
        onClick(fn) { map.on("click", e => fn({ lat: e.latlng.lat, lng: e.latlng.lng })); },
        setYou(pos) {
          if (you) map.removeLayer(you);
          you = L.circleMarker([pos.lat, pos.lng], { radius: 9, color: "#b48b46", fillColor: "#caa45f", fillOpacity: .9, weight: 3 })
            .addTo(map).bindPopup("現在地");
        },
      };
    };
    readyResolve();
  }

  function loadLeaflet() {
    if (window.L) return initLeaflet();
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.onload = initLeaflet;
    document.head.appendChild(s);
  }

  /* subtle luxury style for Google Maps */
  const GOOGLE_STYLE = [
    { elementType: "geometry", stylers: [{ color: "#f7f5f1" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#7d7a72" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#f7f5f1" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#d9e2e6" }] },
    { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#dfe6d5" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#eaddc6" }] },
    { featureType: "poi", elementType: "labels.icon", stylers: [{ saturation: -60 }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
  ];

  /* ---------------- boot ---------------- */
  if (useGoogle) loadGoogle(); else loadLeaflet();
})();
