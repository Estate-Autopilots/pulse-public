'use client';
import {useEffect,useRef,useState} from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type {PortalData} from './types';
// Only the opt-in public-safe projection enters this component. No internal map API is called.
export function ShowcaseMap({publication:p}:{publication:NonNullable<PortalData['publication']>}){
 const host=useRef<HTMLDivElement>(null),[unavailable,setUnavailable]=useState(false);
 useEffect(()=>{if(!host.current)return;let map:maplibregl.Map|undefined;let resize:ResizeObserver|undefined;let themeChanges:MutationObserver|undefined;const style=()=> 'https://tiles.openfreemap.org/styles/'+(document.documentElement.dataset.theme==='dark'?'dark':'positron');
  try{map=new maplibregl.Map({container:host.current,style:style(),center:[p.lng,p.lat],zoom:10,maxZoom:12,attributionControl:false});map.addControl(new maplibregl.AttributionControl({compact:true}));map.addControl(new maplibregl.NavigationControl({showCompass:false}));new maplibregl.Marker({color:'#7657db'}).setLngLat([p.lng,p.lat]).addTo(map);map.on('error',()=>setUnavailable(true));resize=new ResizeObserver(()=>map?.resize());resize.observe(host.current);themeChanges=new MutationObserver(()=>map?.setStyle(style()));themeChanges.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});}catch{queueMicrotask(()=>setUnavailable(true));}return()=>{resize?.disconnect();themeChanges?.disconnect();map?.remove();};
 },[p.lat,p.lng]);
 return <figure style={{margin:0}}><div ref={host} role="img" aria-label={'Opt-in approximate project map: '+p.label} style={{height:180,borderRadius:8,overflow:'hidden'}}/><figcaption style={{fontSize:11,marginTop:8}}>{p.label} · {p.lat}, {p.lng} · approximate location · {p.precision}{unavailable?' · Basemap unavailable; the approved approximate location is retained.':''}</figcaption></figure>;
}
