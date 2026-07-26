var dt=Object.defineProperty;var ft=(d,e,t)=>e in d?dt(d,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):d[e]=t;var Ie=(d,e,t)=>ft(d,typeof e!="symbol"?e+"":e,t);import{a as Je,ak as pt,f as et,o as qe,l as W,al as q,w as xe,am as je,an as Be,ao as L,ap as ut,c as Ge,V as Me,y as ge,aq as tt,R as we,ar as mt,as as de,at as fe,au as Xe,av as Ze,aw as vt,ax as gt,ay as _t,az as xt,aA as Ye,aB as Mt,aC as wt,aD as St,v as bt,aE as Pt,aF as Tt,aG as yt,aH as Et,aI as it,aJ as Ct,aK as Dt,aL as Rt,W as At,ad as Nt,S as kt,P as Ut,G as st,M as Lt,g as Oe,b as Qe}from"./BufferGeometryUtils-Tmsg8VnN.js";class zt{constructor(e){this.target=e,this._keys=new Set,this._pressed=new Set,this._released=new Set,this._bindings=new Map,this.pointer={x:0,y:0,dx:0,dy:0,down:!1,rightDown:!1,wheel:0},this._sticks={left:{id:null,ox:0,oy:0,x:0,y:0},right:{id:null,ox:0,oy:0,x:0,y:0}},this._h=[];const t=(i,s,a,o)=>{i.addEventListener(s,a,o),this._h.push([i,s,a])};t(window,"keydown",i=>{i.repeat||(this._keys.add(i.code),this._pressed.add(i.code))}),t(window,"keyup",i=>{this._keys.delete(i.code),this._released.add(i.code)}),t(window,"blur",()=>this._keys.clear()),t(e,"pointerdown",i=>{if(i.pointerType==="touch")return this._touchStart(i);i.button===0&&(this.pointer.down=!0,this._pressed.add("Mouse0")),i.button===2&&(this.pointer.rightDown=!0,this._pressed.add("Mouse2"))}),t(window,"pointerup",i=>{if(i.pointerType==="touch")return this._touchEnd(i);i.button===0&&(this.pointer.down=!1,this._released.add("Mouse0")),i.button===2&&(this.pointer.rightDown=!1,this._released.add("Mouse2"))}),t(window,"pointermove",i=>{if(i.pointerType==="touch")return this._touchMove(i);this.pointer.dx+=i.movementX,this.pointer.dy+=i.movementY;const s=e.getBoundingClientRect();this.pointer.x=i.clientX-s.left,this.pointer.y=i.clientY-s.top;const a=!!(i.buttons&1),o=!!(i.buttons&2);a!==this.pointer.down&&(this.pointer.down=a,this[a?"_pressed":"_released"].add("Mouse0")),o!==this.pointer.rightDown&&(this.pointer.rightDown=o,this[o?"_pressed":"_released"].add("Mouse2"))}),t(e,"wheel",i=>{this.pointer.wheel+=Math.sign(i.deltaY),i.preventDefault()},{passive:!1}),t(e,"contextmenu",i=>i.preventDefault())}enablePointerLock(){const e=()=>{window.__pfTest&&window.__pfTest.active&&!window.__pfTest.livePlay||document.pointerLockElement!==this.target&&this.target.requestPointerLock()};this.target.addEventListener("pointerdown",e),this._h.push([this.target,"pointerdown",e])}get pointerLocked(){return document.pointerLockElement===this.target}bind(e,t){this._bindings.set(e,t)}down(e){return this._keys.has(e)}pressed(e){return(this._bindings.get(e)??[e]).some(i=>this._pressed.has(i))}released(e){return(this._bindings.get(e)??[e]).some(i=>this._released.has(i))}held(e){return(this._bindings.get(e)??[e]).some(i=>this._keys.has(i))}axis(e,t){return(this.down(t)?1:0)-(this.down(e)?1:0)}stick(e){const t=this._sticks[e];return{x:t.x,y:t.y}}_touchStart(e){const t=this.target.getBoundingClientRect(),i=e.clientX-t.left<t.width/2?"left":"right",s=this._sticks[i];s.id===null&&(s.id=e.pointerId,s.ox=e.clientX,s.oy=e.clientY,s.x=s.y=0)}_touchMove(e){for(const t of Object.values(this._sticks)){if(t.id!==e.pointerId)continue;const i=60;t.x=Math.max(-1,Math.min(1,(e.clientX-t.ox)/i)),t.y=Math.max(-1,Math.min(1,(e.clientY-t.oy)/i))}}_touchEnd(e){for(const t of Object.values(this._sticks))t.id===e.pointerId&&(t.id=null,t.x=t.y=0)}endFrame(){this._pressed.clear(),this._released.clear(),this.pointer.dx=this.pointer.dy=0,this.pointer.wheel=0}dispose(){for(const[e,t,i]of this._h)e.removeEventListener(t,i)}}const X=[],Z=[],Ft={update(d){var e;for(let t=X.length-1;t>=0;t--){const i=X[t];if(i.dead){X.splice(t,1);continue}if(i.delay>0){i.delay-=d;continue}i.t=Math.min(i.t+d/i.dur,1);const s=i.ease(i.forward?i.t:1-i.t);for(const a of Object.keys(i.to))i.obj[a]=i.from[a]+(i.to[a]-i.from[a])*s;if(i.t>=1){if(i.yoyo&&i.forward){i.forward=!1,i.t=0;continue}if(i.repeat>0||i.repeat===1/0){i.repeat!==1/0&&i.repeat--,i.forward=!0,i.t=0;continue}(e=i.onDone)==null||e.call(i),X.splice(t,1)}}for(let t=Z.length-1;t>=0;t--){const i=Z[t];if(i.dead){Z.splice(t,1);continue}i.left-=d,i.left<=0&&(i.fn(),i.repeat?i.left=i.sec:Z.splice(t,1))}},clear(){X.length=0,Z.length=0},get count(){return X.length+Z.length}},_e={name:"CopyShader",uniforms:{tDiffuse:{value:null},opacity:{value:1}},vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		uniform float opacity;

		uniform sampler2D tDiffuse;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );
			gl_FragColor = opacity * texel;


		}`};class Y{constructor(){this.isPass=!0,this.enabled=!0,this.needsSwap=!0,this.clear=!1,this.renderToScreen=!1}setSize(){}render(){console.error("THREE.Pass: .render() must be implemented in derived pass.")}dispose(){}}const It=new pt(-1,1,1,-1,0,1);class Ot extends et{constructor(){super(),this.setAttribute("position",new qe([-1,3,0,-1,-1,0,3,-1,0],3)),this.setAttribute("uv",new qe([0,2,0,0,2,0],2))}}const Vt=new Ot;class He{constructor(e){this._mesh=new Je(Vt,e)}dispose(){this._mesh.geometry.dispose()}render(e){e.render(this._mesh,It)}get material(){return this._mesh.material}set material(e){this._mesh.material=e}}class jt extends Y{constructor(e,t="tDiffuse"){super(),this.textureID=t,this.uniforms=null,this.material=null,e instanceof W?(this.uniforms=e.uniforms,this.material=e):e&&(this.uniforms=q.clone(e.uniforms),this.material=new W({name:e.name!==void 0?e.name:"unspecified",defines:Object.assign({},e.defines),uniforms:this.uniforms,vertexShader:e.vertexShader,fragmentShader:e.fragmentShader})),this._fsQuad=new He(this.material)}render(e,t,i){this.uniforms[this.textureID]&&(this.uniforms[this.textureID].value=i.texture),this._fsQuad.material=this.material,this.renderToScreen?(e.setRenderTarget(null),this._fsQuad.render(e)):(e.setRenderTarget(t),this.clear&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),this._fsQuad.render(e))}dispose(){this.material.dispose(),this._fsQuad.dispose()}}class $e extends Y{constructor(e,t){super(),this.scene=e,this.camera=t,this.clear=!0,this.needsSwap=!1,this.inverse=!1}render(e,t,i){const s=e.getContext(),a=e.state;a.buffers.color.setMask(!1),a.buffers.depth.setMask(!1),a.buffers.color.setLocked(!0),a.buffers.depth.setLocked(!0);let o,n;this.inverse?(o=0,n=1):(o=1,n=0),a.buffers.stencil.setTest(!0),a.buffers.stencil.setOp(s.REPLACE,s.REPLACE,s.REPLACE),a.buffers.stencil.setFunc(s.ALWAYS,o,4294967295),a.buffers.stencil.setClear(n),a.buffers.stencil.setLocked(!0),e.setRenderTarget(i),this.clear&&e.clear(),e.render(this.scene,this.camera),e.setRenderTarget(t),this.clear&&e.clear(),e.render(this.scene,this.camera),a.buffers.color.setLocked(!1),a.buffers.depth.setLocked(!1),a.buffers.color.setMask(!0),a.buffers.depth.setMask(!0),a.buffers.stencil.setLocked(!1),a.buffers.stencil.setFunc(s.EQUAL,1,4294967295),a.buffers.stencil.setOp(s.KEEP,s.KEEP,s.KEEP),a.buffers.stencil.setLocked(!0)}}class Bt extends Y{constructor(){super(),this.needsSwap=!1}render(e){e.state.buffers.stencil.setLocked(!1),e.state.buffers.stencil.setTest(!1)}}class Gt{constructor(e,t){if(this.renderer=e,this._pixelRatio=e.getPixelRatio(),t===void 0){const i=e.getSize(new xe);this._width=i.width,this._height=i.height,t=new je(this._width*this._pixelRatio,this._height*this._pixelRatio,{type:Be}),t.texture.name="EffectComposer.rt1"}else this._width=t.width,this._height=t.height;this.renderTarget1=t,this.renderTarget2=t.clone(),this.renderTarget2.texture.name="EffectComposer.rt2",this.writeBuffer=this.renderTarget1,this.readBuffer=this.renderTarget2,this.renderToScreen=!0,this.passes=[],this.copyPass=new jt(_e),this.copyPass.material.blending=L,this.timer=new ut}swapBuffers(){const e=this.readBuffer;this.readBuffer=this.writeBuffer,this.writeBuffer=e}addPass(e){this.passes.push(e),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}insertPass(e,t){this.passes.splice(t,0,e),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}removePass(e){const t=this.passes.indexOf(e);t!==-1&&this.passes.splice(t,1)}isLastEnabledPass(e){for(let t=e+1;t<this.passes.length;t++)if(this.passes[t].enabled)return!1;return!0}render(e){this.timer.update(),e===void 0&&(e=this.timer.getDelta());const t=this.renderer.getRenderTarget();let i=!1;for(let s=0,a=this.passes.length;s<a;s++){const o=this.passes[s];if(o.enabled!==!1){if(o.renderToScreen=this.renderToScreen&&this.isLastEnabledPass(s),o.render(this.renderer,this.writeBuffer,this.readBuffer,e,i),o.needsSwap){if(i){const n=this.renderer.getContext(),r=this.renderer.state.buffers.stencil;r.setFunc(n.NOTEQUAL,1,4294967295),this.copyPass.render(this.renderer,this.writeBuffer,this.readBuffer,e),r.setFunc(n.EQUAL,1,4294967295)}this.swapBuffers()}$e!==void 0&&(o instanceof $e?i=!0:o instanceof Bt&&(i=!1))}}this.renderer.setRenderTarget(t)}reset(e){if(e===void 0){const t=this.renderer.getSize(new xe);this._pixelRatio=this.renderer.getPixelRatio(),this._width=t.width,this._height=t.height,e=this.renderTarget1.clone(),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}this.renderTarget1.dispose(),this.renderTarget2.dispose(),this.renderTarget1=e,this.renderTarget2=e.clone(),this.writeBuffer=this.renderTarget1,this.readBuffer=this.renderTarget2}setSize(e,t){this._width=e,this._height=t;const i=this._width*this._pixelRatio,s=this._height*this._pixelRatio;this.renderTarget1.setSize(i,s),this.renderTarget2.setSize(i,s);for(let a=0;a<this.passes.length;a++)this.passes[a].setSize(i,s)}setPixelRatio(e){this._pixelRatio=e,this.setSize(this._width,this._height)}dispose(){this.renderTarget1.dispose(),this.renderTarget2.dispose(),this.copyPass.dispose()}}class Ht extends Y{constructor(e,t,i=null,s=null,a=null){super(),this.scene=e,this.camera=t,this.overrideMaterial=i,this.clearColor=s,this.clearAlpha=a,this.clear=!0,this.clearDepth=!1,this.needsSwap=!1,this.isRenderPass=!0,this._oldClearColor=new Ge}render(e,t,i){const s=e.autoClear;e.autoClear=!1;let a,o;this.overrideMaterial!==null&&(o=this.scene.overrideMaterial,this.scene.overrideMaterial=this.overrideMaterial),this.clearColor!==null&&(e.getClearColor(this._oldClearColor),e.setClearColor(this.clearColor,e.getClearAlpha())),this.clearAlpha!==null&&(a=e.getClearAlpha(),e.setClearAlpha(this.clearAlpha)),this.clearDepth==!0&&e.clearDepth(),e.setRenderTarget(this.renderToScreen?null:i),this.clear===!0&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),e.render(this.scene,this.camera),this.clearColor!==null&&e.setClearColor(this._oldClearColor),this.clearAlpha!==null&&e.setClearAlpha(a),this.overrideMaterial!==null&&(this.scene.overrideMaterial=o),e.autoClear=s}}const pe={defines:{PERSPECTIVE_CAMERA:1,SAMPLES:16,NORMAL_VECTOR_TYPE:1,DEPTH_SWIZZLING:"x",SCREEN_SPACE_RADIUS:0,SCREEN_SPACE_RADIUS_SCALE:100,SCENE_CLIP_BOX:0},uniforms:{tNormal:{value:null},tDepth:{value:null},tNoise:{value:null},resolution:{value:new xe},cameraNear:{value:null},cameraFar:{value:null},cameraProjectionMatrix:{value:new ge},cameraProjectionMatrixInverse:{value:new ge},cameraWorldMatrix:{value:new ge},radius:{value:.25},distanceExponent:{value:1},thickness:{value:1},distanceFallOff:{value:1},scale:{value:1},sceneBoxMin:{value:new Me(-1,-1,-1)},sceneBoxMax:{value:new Me(1,1,1)}},vertexShader:`

		varying vec2 vUv;

		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,fragmentShader:`
		varying vec2 vUv;
		uniform highp sampler2D tNormal;
		uniform highp sampler2D tDepth;
		uniform sampler2D tNoise;
		uniform vec2 resolution;
		uniform float cameraNear;
		uniform float cameraFar;
		uniform mat4 cameraProjectionMatrix;
		uniform mat4 cameraProjectionMatrixInverse;
		uniform mat4 cameraWorldMatrix;
		uniform float radius;
		uniform float distanceExponent;
		uniform float thickness;
		uniform float distanceFallOff;
		uniform float scale;
		#if SCENE_CLIP_BOX == 1
			uniform vec3 sceneBoxMin;
			uniform vec3 sceneBoxMax;
		#endif

		#include <common>
		#include <packing>

		#ifndef FRAGMENT_OUTPUT
		#define FRAGMENT_OUTPUT vec4(vec3(ao), 1.)
		#endif

		vec3 getViewPosition( const in vec2 screenPosition, const in float depth ) {
			#ifdef USE_REVERSED_DEPTH_BUFFER
				vec4 clipSpacePosition = vec4( vec2( screenPosition ) * 2.0 - 1.0, depth, 1.0 );
			#else
				vec4 clipSpacePosition = vec4( vec3( screenPosition, depth ) * 2.0 - 1.0, 1.0 );
			#endif
			vec4 viewSpacePosition = cameraProjectionMatrixInverse * clipSpacePosition;
			return viewSpacePosition.xyz / viewSpacePosition.w;
		}

		float getDepth(const vec2 uv) {
			return textureLod(tDepth, uv.xy, 0.0).DEPTH_SWIZZLING;
		}

		float fetchDepth(const ivec2 uv) {
			return texelFetch(tDepth, uv.xy, 0).DEPTH_SWIZZLING;
		}

		float getViewZ(const in float depth) {
			#if PERSPECTIVE_CAMERA == 1
				return perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
			#else
				return orthographicDepthToViewZ(depth, cameraNear, cameraFar);
			#endif
		}

		vec3 computeNormalFromDepth(const vec2 uv) {
			vec2 size = vec2(textureSize(tDepth, 0));
			ivec2 p = ivec2(uv * size);
			float c0 = fetchDepth(p);
			float l2 = fetchDepth(p - ivec2(2, 0));
			float l1 = fetchDepth(p - ivec2(1, 0));
			float r1 = fetchDepth(p + ivec2(1, 0));
			float r2 = fetchDepth(p + ivec2(2, 0));
			float b2 = fetchDepth(p - ivec2(0, 2));
			float b1 = fetchDepth(p - ivec2(0, 1));
			float t1 = fetchDepth(p + ivec2(0, 1));
			float t2 = fetchDepth(p + ivec2(0, 2));
			float dl = abs((2.0 * l1 - l2) - c0);
			float dr = abs((2.0 * r1 - r2) - c0);
			float db = abs((2.0 * b1 - b2) - c0);
			float dt = abs((2.0 * t1 - t2) - c0);
			vec3 ce = getViewPosition(uv, c0).xyz;
			vec3 dpdx = (dl < dr) ? ce - getViewPosition((uv - vec2(1.0 / size.x, 0.0)), l1).xyz : -ce + getViewPosition((uv + vec2(1.0 / size.x, 0.0)), r1).xyz;
			vec3 dpdy = (db < dt) ? ce - getViewPosition((uv - vec2(0.0, 1.0 / size.y)), b1).xyz : -ce + getViewPosition((uv + vec2(0.0, 1.0 / size.y)), t1).xyz;
			return normalize(cross(dpdx, dpdy));
		}

		vec3 getViewNormal(const vec2 uv) {
			#if NORMAL_VECTOR_TYPE == 2
				return normalize(textureLod(tNormal, uv, 0.).rgb);
			#elif NORMAL_VECTOR_TYPE == 1
				return unpackRGBToNormal(textureLod(tNormal, uv, 0.).rgb);
			#else
				return computeNormalFromDepth(uv);
			#endif
		}

		vec3 getSceneUvAndDepth(vec3 sampleViewPos) {
			vec4 sampleClipPos = cameraProjectionMatrix * vec4(sampleViewPos, 1.);
			vec2 sampleUv = sampleClipPos.xy / sampleClipPos.w * 0.5 + 0.5;
			float sampleSceneDepth = getDepth(sampleUv);
			return vec3(sampleUv, sampleSceneDepth);
		}

		void main() {
			float depth = getDepth(vUv.xy);

			#ifdef USE_REVERSED_DEPTH_BUFFER
				if (depth <= 0.0) {
					discard;
					return;
				}
			#else
				if (depth >= 1.0) {
					discard;
					return;
				}
			#endif
			
			vec3 viewPos = getViewPosition(vUv, depth);
			vec3 viewNormal = getViewNormal(vUv);

			float radiusToUse = radius;
			float distanceFalloffToUse = thickness;
			#if SCREEN_SPACE_RADIUS == 1
				float radiusScale = getViewPosition(vec2(0.5 + float(SCREEN_SPACE_RADIUS_SCALE) / resolution.x, 0.0), depth).x;
				radiusToUse *= radiusScale;
				distanceFalloffToUse *= radiusScale;
			#endif

			#if SCENE_CLIP_BOX == 1
				vec3 worldPos = (cameraWorldMatrix * vec4(viewPos, 1.0)).xyz;
				float boxDistance = length(max(vec3(0.0), max(sceneBoxMin - worldPos, worldPos - sceneBoxMax)));
				if (boxDistance > radiusToUse) {
					discard;
					return;
				}
			#endif

			vec2 noiseResolution = vec2(textureSize(tNoise, 0));
			vec2 noiseUv = vUv * resolution / noiseResolution;
			vec4 noiseTexel = textureLod(tNoise, noiseUv, 0.0);
			vec3 randomVec = noiseTexel.xyz * 2.0 - 1.0;
			vec3 tangent = normalize(vec3(randomVec.xy, 0.));
			vec3 bitangent = vec3(-tangent.y, tangent.x, 0.);
			mat3 kernelMatrix = mat3(tangent, bitangent, vec3(0., 0., 1.));

			const int DIRECTIONS = SAMPLES < 30 ? 3 : 5;
			const int STEPS = (SAMPLES + DIRECTIONS - 1) / DIRECTIONS;
			float ao = 0.0;
			for (int i = 0; i < DIRECTIONS; ++i) {

				float angle = float(i) / float(DIRECTIONS) * PI;
				vec4 sampleDir = vec4(cos(angle), sin(angle), 0., 0.5 + 0.5 * noiseTexel.w);
				sampleDir.xyz = normalize(kernelMatrix * sampleDir.xyz);

				vec3 viewDir = normalize(-viewPos.xyz);
				vec3 sliceBitangent = normalize(cross(sampleDir.xyz, viewDir));
				vec3 sliceTangent = cross(sliceBitangent, viewDir);
				vec3 normalInSlice = normalize(viewNormal - sliceBitangent * dot(viewNormal, sliceBitangent));

				vec3 tangentToNormalInSlice = cross(normalInSlice, sliceBitangent);
				vec2 cosHorizons = vec2(dot(viewDir, tangentToNormalInSlice), dot(viewDir, -tangentToNormalInSlice));

				for (int j = 0; j < STEPS; ++j) {
					vec3 sampleViewOffset = sampleDir.xyz * radiusToUse * sampleDir.w * pow(float(j + 1) / float(STEPS), distanceExponent);

					vec3 sampleSceneUvDepth = getSceneUvAndDepth(viewPos + sampleViewOffset);
					vec3 sampleSceneViewPos = getViewPosition(sampleSceneUvDepth.xy, sampleSceneUvDepth.z);
					vec3 viewDelta = sampleSceneViewPos - viewPos;
					if (abs(viewDelta.z) < thickness) {
						float sampleCosHorizon = dot(viewDir, normalize(viewDelta));
						cosHorizons.x += max(0., (sampleCosHorizon - cosHorizons.x) * mix(1., 2. / float(j + 2), distanceFallOff));
					}

					sampleSceneUvDepth = getSceneUvAndDepth(viewPos - sampleViewOffset);
					sampleSceneViewPos = getViewPosition(sampleSceneUvDepth.xy, sampleSceneUvDepth.z);
					viewDelta = sampleSceneViewPos - viewPos;
					if (abs(viewDelta.z) < thickness) {
						float sampleCosHorizon = dot(viewDir, normalize(viewDelta));
						cosHorizons.y += max(0., (sampleCosHorizon - cosHorizons.y) * mix(1., 2. / float(j + 2), distanceFallOff));
					}
				}

				vec2 sinHorizons = sqrt(1. - cosHorizons * cosHorizons);
				float nx = dot(normalInSlice, sliceTangent);
				float ny = dot(normalInSlice, viewDir);
				float nxb = 1. / 2. * (acos(cosHorizons.y) - acos(cosHorizons.x) + sinHorizons.x * cosHorizons.x - sinHorizons.y * cosHorizons.y);
				float nyb = 1. / 2. * (2. - cosHorizons.x * cosHorizons.x - cosHorizons.y * cosHorizons.y);
				float occlusion = nx * nxb + ny * nyb;
				ao += occlusion;
			}

			ao = clamp(ao / float(DIRECTIONS), 0., 1.);
		#if SCENE_CLIP_BOX == 1
			ao = mix(ao, 1., smoothstep(0., radiusToUse, boxDistance));
		#endif
			ao = pow(ao, scale);

			gl_FragColor = FRAGMENT_OUTPUT;
		}`},ue={defines:{PERSPECTIVE_CAMERA:1},uniforms:{tDepth:{value:null},cameraNear:{value:null},cameraFar:{value:null}},vertexShader:`
		varying vec2 vUv;

		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,fragmentShader:`
		uniform sampler2D tDepth;
		uniform float cameraNear;
		uniform float cameraFar;
		varying vec2 vUv;

		#include <packing>

		float getLinearDepth( const in vec2 screenPosition ) {
			#if PERSPECTIVE_CAMERA == 1
				float fragCoordZ = texture2D( tDepth, screenPosition ).x;
				float viewZ = perspectiveDepthToViewZ( fragCoordZ, cameraNear, cameraFar );
				return viewZToOrthographicDepth( viewZ, cameraNear, cameraFar );
			#else
				return texture2D( tDepth, screenPosition ).x;
			#endif
		}

		void main() {
			float depth = getLinearDepth( vUv );
			gl_FragColor = vec4( vec3( 1.0 - depth ), 1.0 );

		}`},Ve={uniforms:{tDiffuse:{value:null},intensity:{value:1}},vertexShader:`
		varying vec2 vUv;

		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,fragmentShader:`
		uniform float intensity;
		uniform sampler2D tDiffuse;
		varying vec2 vUv;

		void main() {
			vec4 texel = texture2D( tDiffuse, vUv );
			gl_FragColor = vec4(mix(vec3(1.), texel.rgb, intensity), texel.a);
		}`};function Wt(d=5){const e=Math.floor(d)%2===0?Math.floor(d)+1:Math.floor(d),t=qt(e),i=t.length,s=new Uint8Array(i*4);for(let o=0;o<i;++o){const n=t[o],r=2*Math.PI*n/i,l=new Me(Math.cos(r),Math.sin(r),0).normalize();s[o*4]=(l.x*.5+.5)*255,s[o*4+1]=(l.y*.5+.5)*255,s[o*4+2]=127,s[o*4+3]=255}const a=new tt(s,e,e);return a.wrapS=we,a.wrapT=we,a.needsUpdate=!0,a}function qt(d){const e=Math.floor(d)%2===0?Math.floor(d)+1:Math.floor(d),t=e*e,i=Array(t).fill(0);let s=Math.floor(e/2),a=e-1;for(let o=1;o<=t;){if(s===-1&&a===e?(a=e-2,s=0):(a===e&&(a=0),s<0&&(s=e-1)),i[s*e+a]!==0){a-=2,s++;continue}else i[s*e+a]=o++;a++,s--}return i}const me={defines:{SAMPLES:16,SAMPLE_VECTORS:at(16,2,1),NORMAL_VECTOR_TYPE:1,DEPTH_VALUE_SOURCE:0},uniforms:{tDiffuse:{value:null},tNormal:{value:null},tDepth:{value:null},tNoise:{value:null},resolution:{value:new xe},cameraProjectionMatrixInverse:{value:new ge},lumaPhi:{value:5},depthPhi:{value:5},normalPhi:{value:5},radius:{value:4},index:{value:0}},vertexShader:`

		varying vec2 vUv;

		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,fragmentShader:`

		varying vec2 vUv;

		uniform sampler2D tDiffuse;
		uniform sampler2D tNormal;
		uniform sampler2D tDepth;
		uniform sampler2D tNoise;
		uniform vec2 resolution;
		uniform mat4 cameraProjectionMatrixInverse;
		uniform float lumaPhi;
		uniform float depthPhi;
		uniform float normalPhi;
		uniform float radius;
		uniform int index;

		#include <common>
		#include <packing>

		#ifndef SAMPLE_LUMINANCE
		#define SAMPLE_LUMINANCE dot(vec3(0.2125, 0.7154, 0.0721), a)
		#endif

		#ifndef FRAGMENT_OUTPUT
		#define FRAGMENT_OUTPUT vec4(denoised, 1.)
		#endif

		float getLuminance(const in vec3 a) {
			return SAMPLE_LUMINANCE;
		}

		const vec3 poissonDisk[SAMPLES] = SAMPLE_VECTORS;

		vec3 getViewPosition( const in vec2 screenPosition, const in float depth ) {
			#ifdef USE_REVERSED_DEPTH_BUFFER
				vec4 clipSpacePosition = vec4( vec2( screenPosition ) * 2.0 - 1.0, depth, 1.0 );
			#else
				vec4 clipSpacePosition = vec4( vec3( screenPosition, depth ) * 2.0 - 1.0, 1.0 );
			#endif
			vec4 viewSpacePosition = cameraProjectionMatrixInverse * clipSpacePosition;
			return viewSpacePosition.xyz / viewSpacePosition.w;
		}

		float getDepth(const vec2 uv) {
		#if DEPTH_VALUE_SOURCE == 1
			return textureLod(tDepth, uv.xy, 0.0).a;
		#else
			return textureLod(tDepth, uv.xy, 0.0).r;
		#endif
		}

		float fetchDepth(const ivec2 uv) {
			#if DEPTH_VALUE_SOURCE == 1
				return texelFetch(tDepth, uv.xy, 0).a;
			#else
				return texelFetch(tDepth, uv.xy, 0).r;
			#endif
		}

		vec3 computeNormalFromDepth(const vec2 uv) {
			vec2 size = vec2(textureSize(tDepth, 0));
			ivec2 p = ivec2(uv * size);
			float c0 = fetchDepth(p);
			float l2 = fetchDepth(p - ivec2(2, 0));
			float l1 = fetchDepth(p - ivec2(1, 0));
			float r1 = fetchDepth(p + ivec2(1, 0));
			float r2 = fetchDepth(p + ivec2(2, 0));
			float b2 = fetchDepth(p - ivec2(0, 2));
			float b1 = fetchDepth(p - ivec2(0, 1));
			float t1 = fetchDepth(p + ivec2(0, 1));
			float t2 = fetchDepth(p + ivec2(0, 2));
			float dl = abs((2.0 * l1 - l2) - c0);
			float dr = abs((2.0 * r1 - r2) - c0);
			float db = abs((2.0 * b1 - b2) - c0);
			float dt = abs((2.0 * t1 - t2) - c0);
			vec3 ce = getViewPosition(uv, c0).xyz;
			vec3 dpdx = (dl < dr) ?  ce - getViewPosition((uv - vec2(1.0 / size.x, 0.0)), l1).xyz
									: -ce + getViewPosition((uv + vec2(1.0 / size.x, 0.0)), r1).xyz;
			vec3 dpdy = (db < dt) ?  ce - getViewPosition((uv - vec2(0.0, 1.0 / size.y)), b1).xyz
									: -ce + getViewPosition((uv + vec2(0.0, 1.0 / size.y)), t1).xyz;
			return normalize(cross(dpdx, dpdy));
		}

		vec3 getViewNormal(const vec2 uv) {
		#if NORMAL_VECTOR_TYPE == 2
			return normalize(textureLod(tNormal, uv, 0.).rgb);
		#elif NORMAL_VECTOR_TYPE == 1
			return unpackRGBToNormal(textureLod(tNormal, uv, 0.).rgb);
		#else
			return computeNormalFromDepth(uv);
		#endif
		}

		void denoiseSample(in vec3 center, in vec3 viewNormal, in vec3 viewPos, in vec2 sampleUv, inout vec3 denoised, inout float totalWeight) {
			vec4 sampleTexel = textureLod(tDiffuse, sampleUv, 0.0);
			float sampleDepth = getDepth(sampleUv);
			vec3 sampleNormal = getViewNormal(sampleUv);
			vec3 neighborColor = sampleTexel.rgb;
			vec3 viewPosSample = getViewPosition(sampleUv, sampleDepth);

			float normalDiff = dot(viewNormal, sampleNormal);
			float normalSimilarity = pow(max(normalDiff, 0.), normalPhi);
			float lumaDiff = abs(getLuminance(neighborColor) - getLuminance(center));
			float lumaSimilarity = max(1.0 - lumaDiff / lumaPhi, 0.0);
			float depthDiff = abs(dot(viewPos - viewPosSample, viewNormal));
			float depthSimilarity = max(1. - depthDiff / depthPhi, 0.);
			float w = lumaSimilarity * depthSimilarity * normalSimilarity;

			denoised += w * neighborColor;
			totalWeight += w;
		}

		void main() {
			float depth = getDepth(vUv.xy);
			vec3 viewNormal = getViewNormal(vUv);
			if (depth == 1. || dot(viewNormal, viewNormal) == 0.) {
				discard;
				return;
			}
			vec4 texel = textureLod(tDiffuse, vUv, 0.0);
			vec3 center = texel.rgb;
			vec3 viewPos = getViewPosition(vUv, depth);

			vec2 noiseResolution = vec2(textureSize(tNoise, 0));
			vec2 noiseUv = vUv * resolution / noiseResolution;
			vec4 noiseTexel = textureLod(tNoise, noiseUv, 0.0);
      		vec2 noiseVec = vec2(sin(noiseTexel[index % 4] * 2. * PI), cos(noiseTexel[index % 4] * 2. * PI));
    		mat2 rotationMatrix = mat2(noiseVec.x, -noiseVec.y, noiseVec.x, noiseVec.y);

			float totalWeight = 1.0;
			vec3 denoised = texel.rgb;
			for (int i = 0; i < SAMPLES; i++) {
				vec3 sampleDir = poissonDisk[i];
				vec2 offset = rotationMatrix * (sampleDir.xy * (1. + sampleDir.z * (radius - 1.)) / resolution);
				vec2 sampleUv = vUv + offset;
				denoiseSample(center, viewNormal, viewPos, sampleUv, denoised, totalWeight);
			}

			if (totalWeight > 0.) {
				denoised /= totalWeight;
			}
			gl_FragColor = FRAGMENT_OUTPUT;
		}`};function at(d,e,t){const i=Xt(d,e,t);let s="vec3[SAMPLES](";for(let a=0;a<d;a++){const o=i[a];s+=`vec3(${o.x}, ${o.y}, ${o.z})${a<d-1?",":")"}`}return s}function Xt(d,e,t){const i=[];for(let s=0;s<d;s++){const a=2*Math.PI*e*s/d,o=Math.pow(s/(d-1),t);i.push(new Me(Math.cos(a),Math.sin(a),o))}return i}class Zt{constructor(e=Math){this.grad3=[[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]],this.grad4=[[0,1,1,1],[0,1,1,-1],[0,1,-1,1],[0,1,-1,-1],[0,-1,1,1],[0,-1,1,-1],[0,-1,-1,1],[0,-1,-1,-1],[1,0,1,1],[1,0,1,-1],[1,0,-1,1],[1,0,-1,-1],[-1,0,1,1],[-1,0,1,-1],[-1,0,-1,1],[-1,0,-1,-1],[1,1,0,1],[1,1,0,-1],[1,-1,0,1],[1,-1,0,-1],[-1,1,0,1],[-1,1,0,-1],[-1,-1,0,1],[-1,-1,0,-1],[1,1,1,0],[1,1,-1,0],[1,-1,1,0],[1,-1,-1,0],[-1,1,1,0],[-1,1,-1,0],[-1,-1,1,0],[-1,-1,-1,0]],this.p=[];for(let t=0;t<256;t++)this.p[t]=Math.floor(e.random()*256);this.perm=[];for(let t=0;t<512;t++)this.perm[t]=this.p[t&255];this.simplex=[[0,1,2,3],[0,1,3,2],[0,0,0,0],[0,2,3,1],[0,0,0,0],[0,0,0,0],[0,0,0,0],[1,2,3,0],[0,2,1,3],[0,0,0,0],[0,3,1,2],[0,3,2,1],[0,0,0,0],[0,0,0,0],[0,0,0,0],[1,3,2,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[1,2,0,3],[0,0,0,0],[1,3,0,2],[0,0,0,0],[0,0,0,0],[0,0,0,0],[2,3,0,1],[2,3,1,0],[1,0,2,3],[1,0,3,2],[0,0,0,0],[0,0,0,0],[0,0,0,0],[2,0,3,1],[0,0,0,0],[2,1,3,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[2,0,1,3],[0,0,0,0],[0,0,0,0],[0,0,0,0],[3,0,1,2],[3,0,2,1],[0,0,0,0],[3,1,2,0],[2,1,0,3],[0,0,0,0],[0,0,0,0],[0,0,0,0],[3,1,0,2],[0,0,0,0],[3,2,0,1],[3,2,1,0]]}noise(e,t){let i,s,a;const o=.5*(Math.sqrt(3)-1),n=(e+t)*o,r=Math.floor(e+n),l=Math.floor(t+n),x=(3-Math.sqrt(3))/6,_=(r+l)*x,D=r-_,c=l-_,f=e-D,h=t-c;let p,b;f>h?(p=1,b=0):(p=0,b=1);const P=f-p+x,S=h-b+x,w=f-1+2*x,T=h-1+2*x,C=r&255,y=l&255,v=this.perm[C+this.perm[y]]%12,u=this.perm[C+p+this.perm[y+b]]%12,g=this.perm[C+1+this.perm[y+1]]%12;let M=.5-f*f-h*h;M<0?i=0:(M*=M,i=M*M*this._dot(this.grad3[v],f,h));let m=.5-P*P-S*S;m<0?s=0:(m*=m,s=m*m*this._dot(this.grad3[u],P,S));let E=.5-w*w-T*T;return E<0?a=0:(E*=E,a=E*E*this._dot(this.grad3[g],w,T)),70*(i+s+a)}noise3d(e,t,i){let s,a,o,n;const l=(e+t+i)*.3333333333333333,x=Math.floor(e+l),_=Math.floor(t+l),D=Math.floor(i+l),c=1/6,f=(x+_+D)*c,h=x-f,p=_-f,b=D-f,P=e-h,S=t-p,w=i-b;let T,C,y,v,u,g;P>=S?S>=w?(T=1,C=0,y=0,v=1,u=1,g=0):P>=w?(T=1,C=0,y=0,v=1,u=0,g=1):(T=0,C=0,y=1,v=1,u=0,g=1):S<w?(T=0,C=0,y=1,v=0,u=1,g=1):P<w?(T=0,C=1,y=0,v=0,u=1,g=1):(T=0,C=1,y=0,v=1,u=1,g=0);const M=P-T+c,m=S-C+c,E=w-y+c,k=P-v+2*c,A=S-u+2*c,N=w-g+2*c,j=P-1+3*c,Q=S-1+3*c,R=w-1+3*c,B=x&255,G=_&255,H=D&255,re=this.perm[B+this.perm[G+this.perm[H]]]%12,le=this.perm[B+T+this.perm[G+C+this.perm[H+y]]]%12,he=this.perm[B+v+this.perm[G+u+this.perm[H+g]]]%12,ce=this.perm[B+1+this.perm[G+1+this.perm[H+1]]]%12;let F=.6-P*P-S*S-w*w;F<0?s=0:(F*=F,s=F*F*this._dot3(this.grad3[re],P,S,w));let I=.6-M*M-m*m-E*E;I<0?a=0:(I*=I,a=I*I*this._dot3(this.grad3[le],M,m,E));let O=.6-k*k-A*A-N*N;O<0?o=0:(O*=O,o=O*O*this._dot3(this.grad3[he],k,A,N));let V=.6-j*j-Q*Q-R*R;return V<0?n=0:(V*=V,n=V*V*this._dot3(this.grad3[ce],j,Q,R)),32*(s+a+o+n)}noise4d(e,t,i,s){const a=this.grad4,o=this.simplex,n=this.perm,r=(Math.sqrt(5)-1)/4,l=(5-Math.sqrt(5))/20;let x,_,D,c,f;const h=(e+t+i+s)*r,p=Math.floor(e+h),b=Math.floor(t+h),P=Math.floor(i+h),S=Math.floor(s+h),w=(p+b+P+S)*l,T=p-w,C=b-w,y=P-w,v=S-w,u=e-T,g=t-C,M=i-y,m=s-v,E=u>g?32:0,k=u>M?16:0,A=g>M?8:0,N=u>m?4:0,j=g>m?2:0,Q=M>m?1:0,R=E+k+A+N+j+Q,B=o[R][0]>=3?1:0,G=o[R][1]>=3?1:0,H=o[R][2]>=3?1:0,re=o[R][3]>=3?1:0,le=o[R][0]>=2?1:0,he=o[R][1]>=2?1:0,ce=o[R][2]>=2?1:0,F=o[R][3]>=2?1:0,I=o[R][0]>=1?1:0,O=o[R][1]>=1?1:0,V=o[R][2]>=1?1:0,We=o[R][3]>=1?1:0,Se=u-B+l,be=g-G+l,Pe=M-H+l,Te=m-re+l,ye=u-le+2*l,Ee=g-he+2*l,Ce=M-ce+2*l,De=m-F+2*l,Re=u-I+3*l,Ae=g-O+3*l,Ne=M-V+3*l,ke=m-We+3*l,Ue=u-1+4*l,Le=g-1+4*l,ze=M-1+4*l,Fe=m-1+4*l,$=p&255,K=b&255,J=P&255,ee=S&255,nt=n[$+n[K+n[J+n[ee]]]]%32,rt=n[$+B+n[K+G+n[J+H+n[ee+re]]]]%32,lt=n[$+le+n[K+he+n[J+ce+n[ee+F]]]]%32,ht=n[$+I+n[K+O+n[J+V+n[ee+We]]]]%32,ct=n[$+1+n[K+1+n[J+1+n[ee+1]]]]%32;let te=.6-u*u-g*g-M*M-m*m;te<0?x=0:(te*=te,x=te*te*this._dot4(a[nt],u,g,M,m));let ie=.6-Se*Se-be*be-Pe*Pe-Te*Te;ie<0?_=0:(ie*=ie,_=ie*ie*this._dot4(a[rt],Se,be,Pe,Te));let se=.6-ye*ye-Ee*Ee-Ce*Ce-De*De;se<0?D=0:(se*=se,D=se*se*this._dot4(a[lt],ye,Ee,Ce,De));let ae=.6-Re*Re-Ae*Ae-Ne*Ne-ke*ke;ae<0?c=0:(ae*=ae,c=ae*ae*this._dot4(a[ht],Re,Ae,Ne,ke));let oe=.6-Ue*Ue-Le*Le-ze*ze-Fe*Fe;return oe<0?f=0:(oe*=oe,f=oe*oe*this._dot4(a[ct],Ue,Le,ze,Fe)),27*(x+_+D+c+f)}_dot(e,t,i){return e[0]*t+e[1]*i}_dot3(e,t,i,s){return e[0]*t+e[1]*i+e[2]*s}_dot4(e,t,i,s,a){return e[0]*t+e[1]*i+e[2]*s+e[3]*a}}class U extends Y{constructor(e,t,i=512,s=512,a,o,n){super(),this.width=i,this.height=s,this.clear=!0,this.camera=t,this.scene=e,this.output=0,this._renderGBuffer=!0,this._visibilityCache=[],this.blendIntensity=1,this.pdRings=2,this.pdRadiusExponent=2,this.pdSamples=16,this.gtaoNoiseTexture=Wt(),this.pdNoiseTexture=this._generateNoise(),this.gtaoRenderTarget=new je(this.width,this.height,{type:Be}),this.pdRenderTarget=this.gtaoRenderTarget.clone(),this.gtaoMaterial=new W({defines:Object.assign({},pe.defines),uniforms:q.clone(pe.uniforms),vertexShader:pe.vertexShader,fragmentShader:pe.fragmentShader,blending:L,depthTest:!1,depthWrite:!1}),this.gtaoMaterial.defines.PERSPECTIVE_CAMERA=this.camera.isPerspectiveCamera?1:0,this.gtaoMaterial.uniforms.tNoise.value=this.gtaoNoiseTexture,this.gtaoMaterial.uniforms.resolution.value.set(this.width,this.height),this.gtaoMaterial.uniforms.cameraNear.value=this.camera.near,this.gtaoMaterial.uniforms.cameraFar.value=this.camera.far,this.normalMaterial=new mt,this.normalMaterial.blending=L,this.pdMaterial=new W({defines:Object.assign({},me.defines),uniforms:q.clone(me.uniforms),vertexShader:me.vertexShader,fragmentShader:me.fragmentShader,depthTest:!1,depthWrite:!1}),this.pdMaterial.uniforms.tDiffuse.value=this.gtaoRenderTarget.texture,this.pdMaterial.uniforms.tNoise.value=this.pdNoiseTexture,this.pdMaterial.uniforms.resolution.value.set(this.width,this.height),this.pdMaterial.uniforms.lumaPhi.value=10,this.pdMaterial.uniforms.depthPhi.value=2,this.pdMaterial.uniforms.normalPhi.value=3,this.pdMaterial.uniforms.radius.value=8,this.depthRenderMaterial=new W({defines:Object.assign({},ue.defines),uniforms:q.clone(ue.uniforms),vertexShader:ue.vertexShader,fragmentShader:ue.fragmentShader,blending:L}),this.depthRenderMaterial.uniforms.cameraNear.value=this.camera.near,this.depthRenderMaterial.uniforms.cameraFar.value=this.camera.far,this.copyMaterial=new W({uniforms:q.clone(_e.uniforms),vertexShader:_e.vertexShader,fragmentShader:_e.fragmentShader,transparent:!0,depthTest:!1,depthWrite:!1,blendSrc:Ze,blendDst:fe,blendEquation:de,blendSrcAlpha:Xe,blendDstAlpha:fe,blendEquationAlpha:de}),this.blendMaterial=new W({uniforms:q.clone(Ve.uniforms),vertexShader:Ve.vertexShader,fragmentShader:Ve.fragmentShader,transparent:!0,depthTest:!1,depthWrite:!1,blending:vt,blendSrc:Ze,blendDst:fe,blendEquation:de,blendSrcAlpha:Xe,blendDstAlpha:fe,blendEquationAlpha:de}),this._fsQuad=new He(null),this._originalClearColor=new Ge,this.setGBuffer(a?a.depthTexture:void 0,a?a.normalTexture:void 0),o!==void 0&&this.updateGtaoMaterial(o),n!==void 0&&this.updatePdMaterial(n)}setSize(e,t){this.width=e,this.height=t,this.gtaoRenderTarget.setSize(e,t),this.normalRenderTarget.setSize(e,t),this.pdRenderTarget.setSize(e,t),this.gtaoMaterial.uniforms.resolution.value.set(e,t),this.gtaoMaterial.uniforms.cameraProjectionMatrix.value.copy(this.camera.projectionMatrix),this.gtaoMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse),this.pdMaterial.uniforms.resolution.value.set(e,t),this.pdMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse)}dispose(){this.gtaoNoiseTexture.dispose(),this.pdNoiseTexture.dispose(),this.normalRenderTarget.dispose(),this.gtaoRenderTarget.dispose(),this.pdRenderTarget.dispose(),this.normalMaterial.dispose(),this.pdMaterial.dispose(),this.copyMaterial.dispose(),this.depthRenderMaterial.dispose(),this._fsQuad.dispose()}get gtaoMap(){return this.pdRenderTarget.texture}setGBuffer(e,t){e!==void 0?(this.depthTexture=e,this.normalTexture=t,this._renderGBuffer=!1):(this.depthTexture=new gt,this.depthTexture.format=_t,this.depthTexture.type=xt,this.normalRenderTarget=new je(this.width,this.height,{minFilter:Ye,magFilter:Ye,type:Be,depthTexture:this.depthTexture}),this.normalTexture=this.normalRenderTarget.texture,this._renderGBuffer=!0);const i=this.normalTexture?1:0,s=this.depthTexture===this.normalTexture?"w":"x";this.gtaoMaterial.defines.NORMAL_VECTOR_TYPE=i,this.gtaoMaterial.defines.DEPTH_SWIZZLING=s,this.gtaoMaterial.uniforms.tNormal.value=this.normalTexture,this.gtaoMaterial.uniforms.tDepth.value=this.depthTexture,this.pdMaterial.defines.NORMAL_VECTOR_TYPE=i,this.pdMaterial.defines.DEPTH_SWIZZLING=s,this.pdMaterial.uniforms.tNormal.value=this.normalTexture,this.pdMaterial.uniforms.tDepth.value=this.depthTexture,this.depthRenderMaterial.uniforms.tDepth.value=this.normalRenderTarget.depthTexture}setSceneClipBox(e){e?(this.gtaoMaterial.needsUpdate=this.gtaoMaterial.defines.SCENE_CLIP_BOX!==1,this.gtaoMaterial.defines.SCENE_CLIP_BOX=1,this.gtaoMaterial.uniforms.sceneBoxMin.value.copy(e.min),this.gtaoMaterial.uniforms.sceneBoxMax.value.copy(e.max)):(this.gtaoMaterial.needsUpdate=this.gtaoMaterial.defines.SCENE_CLIP_BOX===0,this.gtaoMaterial.defines.SCENE_CLIP_BOX=0)}updateGtaoMaterial(e){e.radius!==void 0&&(this.gtaoMaterial.uniforms.radius.value=e.radius),e.distanceExponent!==void 0&&(this.gtaoMaterial.uniforms.distanceExponent.value=e.distanceExponent),e.thickness!==void 0&&(this.gtaoMaterial.uniforms.thickness.value=e.thickness),e.distanceFallOff!==void 0&&(this.gtaoMaterial.uniforms.distanceFallOff.value=e.distanceFallOff,this.gtaoMaterial.needsUpdate=!0),e.scale!==void 0&&(this.gtaoMaterial.uniforms.scale.value=e.scale),e.samples!==void 0&&e.samples!==this.gtaoMaterial.defines.SAMPLES&&(this.gtaoMaterial.defines.SAMPLES=e.samples,this.gtaoMaterial.needsUpdate=!0),e.screenSpaceRadius!==void 0&&(e.screenSpaceRadius?1:0)!==this.gtaoMaterial.defines.SCREEN_SPACE_RADIUS&&(this.gtaoMaterial.defines.SCREEN_SPACE_RADIUS=e.screenSpaceRadius?1:0,this.gtaoMaterial.needsUpdate=!0)}updatePdMaterial(e){let t=!1;e.lumaPhi!==void 0&&(this.pdMaterial.uniforms.lumaPhi.value=e.lumaPhi),e.depthPhi!==void 0&&(this.pdMaterial.uniforms.depthPhi.value=e.depthPhi),e.normalPhi!==void 0&&(this.pdMaterial.uniforms.normalPhi.value=e.normalPhi),e.radius!==void 0&&e.radius!==this.radius&&(this.pdMaterial.uniforms.radius.value=e.radius),e.radiusExponent!==void 0&&e.radiusExponent!==this.pdRadiusExponent&&(this.pdRadiusExponent=e.radiusExponent,t=!0),e.rings!==void 0&&e.rings!==this.pdRings&&(this.pdRings=e.rings,t=!0),e.samples!==void 0&&e.samples!==this.pdSamples&&(this.pdSamples=e.samples,t=!0),t&&(this.pdMaterial.defines.SAMPLES=this.pdSamples,this.pdMaterial.defines.SAMPLE_VECTORS=at(this.pdSamples,this.pdRings,this.pdRadiusExponent),this.pdMaterial.needsUpdate=!0)}render(e,t,i){switch(this._renderGBuffer&&(this._overrideVisibility(),this._renderOverride(e,this.normalMaterial,this.normalRenderTarget,7829503,1),this._restoreVisibility()),this.gtaoMaterial.uniforms.cameraNear.value=this.camera.near,this.gtaoMaterial.uniforms.cameraFar.value=this.camera.far,this.gtaoMaterial.uniforms.cameraProjectionMatrix.value.copy(this.camera.projectionMatrix),this.gtaoMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse),this.gtaoMaterial.uniforms.cameraWorldMatrix.value.copy(this.camera.matrixWorld),this._renderPass(e,this.gtaoMaterial,this.gtaoRenderTarget,16777215,1),this.pdMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse),this._renderPass(e,this.pdMaterial,this.pdRenderTarget,16777215,1),this.output){case U.OUTPUT.Off:break;case U.OUTPUT.Diffuse:this.copyMaterial.uniforms.tDiffuse.value=i.texture,this.copyMaterial.blending=L,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t);break;case U.OUTPUT.AO:this.copyMaterial.uniforms.tDiffuse.value=this.gtaoRenderTarget.texture,this.copyMaterial.blending=L,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t);break;case U.OUTPUT.Denoise:this.copyMaterial.uniforms.tDiffuse.value=this.pdRenderTarget.texture,this.copyMaterial.blending=L,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t);break;case U.OUTPUT.Depth:this.depthRenderMaterial.uniforms.cameraNear.value=this.camera.near,this.depthRenderMaterial.uniforms.cameraFar.value=this.camera.far,this._renderPass(e,this.depthRenderMaterial,this.renderToScreen?null:t);break;case U.OUTPUT.Normal:this.copyMaterial.uniforms.tDiffuse.value=this.normalRenderTarget.texture,this.copyMaterial.blending=L,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t);break;case U.OUTPUT.Default:this.copyMaterial.uniforms.tDiffuse.value=i.texture,this.copyMaterial.blending=L,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t),this.blendMaterial.uniforms.intensity.value=this.blendIntensity,this.blendMaterial.uniforms.tDiffuse.value=this.pdRenderTarget.texture,this._renderPass(e,this.blendMaterial,this.renderToScreen?null:t);break;default:console.warn("THREE.GTAOPass: Unknown output type.")}}_renderPass(e,t,i,s,a){e.getClearColor(this._originalClearColor);const o=e.getClearAlpha(),n=e.autoClear;e.setRenderTarget(i),e.autoClear=!1,s!=null&&(e.setClearColor(s),e.setClearAlpha(a||0),e.clear()),this._fsQuad.material=t,this._fsQuad.render(e),e.autoClear=n,e.setClearColor(this._originalClearColor),e.setClearAlpha(o)}_renderOverride(e,t,i,s,a){e.getClearColor(this._originalClearColor);const o=e.getClearAlpha(),n=e.autoClear;e.setRenderTarget(i),e.autoClear=!1,s=t.clearColor||s,a=t.clearAlpha||a,s!=null&&(e.setClearColor(s),e.setClearAlpha(a||0),e.clear()),this.scene.overrideMaterial=t,e.render(this.scene,this.camera),this.scene.overrideMaterial=null,e.autoClear=n,e.setClearColor(this._originalClearColor),e.setClearAlpha(o)}_overrideVisibility(){const e=this.scene,t=this._visibilityCache;e.traverse(function(i){(i.isPoints||i.isLine||i.isLine2)&&i.visible&&(i.visible=!1,t.push(i))})}_restoreVisibility(){const e=this._visibilityCache;for(let t=0;t<e.length;t++)e[t].visible=!0;e.length=0}_generateNoise(e=64){const t=new Zt,i=e*e*4,s=new Uint8Array(i);for(let o=0;o<e;o++)for(let n=0;n<e;n++){const r=o,l=n;s[(o*e+n)*4]=(t.noise(r,l)*.5+.5)*255,s[(o*e+n)*4+1]=(t.noise(r+e,l)*.5+.5)*255,s[(o*e+n)*4+2]=(t.noise(r,l+e)*.5+.5)*255,s[(o*e+n)*4+3]=(t.noise(r+e,l+e)*.5+.5)*255}const a=new tt(s,e,e,Mt,wt);return a.wrapS=we,a.wrapT=we,a.needsUpdate=!0,a}}U.OUTPUT={Off:-1,Default:0,Diffuse:1,Depth:2,Normal:3,AO:4,Denoise:5};const ve={name:"OutputShader",uniforms:{tDiffuse:{value:null},toneMappingExposure:{value:1}},vertexShader:`
		precision highp float;

		uniform mat4 modelViewMatrix;
		uniform mat4 projectionMatrix;

		attribute vec3 position;
		attribute vec2 uv;

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		precision highp float;

		uniform sampler2D tDiffuse;

		#include <tonemapping_pars_fragment>
		#include <colorspace_pars_fragment>

		varying vec2 vUv;

		void main() {

			gl_FragColor = texture2D( tDiffuse, vUv );

			// tone mapping

			#ifdef LINEAR_TONE_MAPPING

				gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );

			#elif defined( REINHARD_TONE_MAPPING )

				gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );

			#elif defined( CINEON_TONE_MAPPING )

				gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );

			#elif defined( ACES_FILMIC_TONE_MAPPING )

				gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );

			#elif defined( AGX_TONE_MAPPING )

				gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );

			#elif defined( NEUTRAL_TONE_MAPPING )

				gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );

			#elif defined( CUSTOM_TONE_MAPPING )

				gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );

			#endif

			// color space

			#ifdef SRGB_TRANSFER

				gl_FragColor = sRGBTransferOETF( gl_FragColor );

			#endif

		}`};class Yt extends Y{constructor(){super(),this.isOutputPass=!0,this.uniforms=q.clone(ve.uniforms),this.material=new St({name:ve.name,uniforms:this.uniforms,vertexShader:ve.vertexShader,fragmentShader:ve.fragmentShader}),this._fsQuad=new He(this.material),this._outputColorSpace=null,this._toneMapping=null}render(e,t,i){this.uniforms.tDiffuse.value=i.texture,this.uniforms.toneMappingExposure.value=e.toneMappingExposure,(this._outputColorSpace!==e.outputColorSpace||this._toneMapping!==e.toneMapping)&&(this._outputColorSpace=e.outputColorSpace,this._toneMapping=e.toneMapping,this.material.defines={},bt.getTransfer(this._outputColorSpace)===Pt&&(this.material.defines.SRGB_TRANSFER=""),this._toneMapping===Tt?this.material.defines.LINEAR_TONE_MAPPING="":this._toneMapping===yt?this.material.defines.REINHARD_TONE_MAPPING="":this._toneMapping===Et?this.material.defines.CINEON_TONE_MAPPING="":this._toneMapping===it?this.material.defines.ACES_FILMIC_TONE_MAPPING="":this._toneMapping===Ct?this.material.defines.AGX_TONE_MAPPING="":this._toneMapping===Dt?this.material.defines.NEUTRAL_TONE_MAPPING="":this._toneMapping===Rt&&(this.material.defines.CUSTOM_TONE_MAPPING=""),this.material.needsUpdate=!0),this.renderToScreen===!0?(e.setRenderTarget(null),this._fsQuad.render(e)):(e.setRenderTarget(t),this.clear&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),this._fsQuad.render(e))}dispose(){this.material.dispose(),this._fsQuad.dispose()}}const z=class z{constructor(e,{clearColor:t=1053466,shadows:i=!0}={}){this.canvas=e,this.renderer=new At({canvas:e,antialias:!0}),this.renderer.setPixelRatio(Math.min(window.devicePixelRatio,2)),this.renderer.setClearColor(t),this.renderer.shadowMap.enabled=i,this.renderer.shadowMap.type=Nt,this.renderer.toneMapping=it,this.renderer.toneMappingExposure=1.15,this.input=new zt(e),this.world=null,this.time=0,this.running=!1,this.aoEnabled=typeof location<"u"&&new URLSearchParams(location.search).get("ao")==="1",this._composer=null,this._accum=0,this._last=0,this._frame=this._frame.bind(this),this._onResize=this._onResize.bind(this),window.addEventListener("resize",this._onResize),this._onResize()}start(){this.running||(this.running=!0,this._last=performance.now(),requestAnimationFrame(this._frame))}stop(){this.running=!1}_frame(e){if(!this.running)return;requestAnimationFrame(this._frame);let t=(e-this._last)/1e3;this._last=e,t=Math.min(t,.25),this.time+=t;const i=this.world;if(i){this._accum+=t;let s=0;for(;this._accum>=z.FIXED_DT&&s<z.MAX_CATCHUP;)i._fixedUpdate(z.FIXED_DT,this),this._accum-=z.FIXED_DT,s++;s===z.MAX_CATCHUP&&(this._accum=0),Ft.update(t),i._update(t,this),i.camera&&(this.aoEnabled&&!this._composer&&this._buildComposer(i),this._composer?((this._rp.camera!==i.camera||this._rp.scene!==i.scene)&&(this._rp.camera=i.camera,this._rp.scene=i.scene,this._gtao.camera=i.camera,this._gtao.scene=i.scene),this._composer.render()):this.renderer.render(i.scene,i.camera))}this.input.endFrame()}_buildComposer(e){const t=this.canvas.clientWidth||window.innerWidth,i=this.canvas.clientHeight||window.innerHeight;this._composer=new Gt(this.renderer),this._rp=new Ht(e.scene,e.camera),this._gtao=new U(e.scene,e.camera,t,i),this._gtao.output=U.OUTPUT.Default,this._composer.addPass(this._rp),this._composer.addPass(this._gtao),this._composer.addPass(new Yt),typeof window<"u"&&(window.__pfAO=this._gtao)}_onResize(){var i,s;const e=this.canvas.clientWidth||window.innerWidth,t=this.canvas.clientHeight||window.innerHeight;this.renderer.setSize(e,t,!1),(i=this._composer)==null||i.setSize(e,t),this.aspect=e/t,(s=this.world)!=null&&s.camera&&(this.world.camera.aspect=this.aspect,this.world.camera.updateProjectionMatrix())}dispose(){this.stop(),window.removeEventListener("resize",this._onResize),this.input.dispose(),this.renderer.dispose()}};Ie(z,"FIXED_DT",1/60),Ie(z,"MAX_CATCHUP",5);let Ke=z;class ei{constructor(){this.scene=new kt,this.camera=new Ut(70,16/9,.1,2e3),this.entities=[],this._pendingRemove=new Set}spawn(e="entity"){var i;const t=new Qt(e,this);this.entities.push(t),this.scene.add(t.object3d);for(const s of t.components)(i=s.init)==null||i.call(s,t,this);return t}destroy(e){this._pendingRemove.add(e)}find(e){return this.entities.find(t=>t.name===e)??null}findAll(e){return this.entities.filter(t=>t.name===e)}_fixedUpdate(e,t){var i;for(const s of this.entities)if(!this._pendingRemove.has(s))for(const a of s.components)(i=a.fixedUpdate)==null||i.call(a,e,{engine:t,world:this,input:t.input,entity:s});this._flush()}_update(e,t){var i;for(const s of this.entities)if(!this._pendingRemove.has(s))for(const a of s.components)(i=a.update)==null||i.call(a,e,{engine:t,world:this,input:t.input,entity:s});this._flush()}_flush(){var e;if(this._pendingRemove.size){for(const t of this._pendingRemove){const i=this.entities.indexOf(t);i>=0&&this.entities.splice(i,1),this.scene.remove(t.object3d);for(const s of t.components)(e=s.dispose)==null||e.call(s)}this._pendingRemove.clear()}}}class Qt{constructor(e,t){this.name=e,this.world=t,this.object3d=new st,this.object3d.name=e,this.components=[]}at(e,t,i){return this.object3d.position.set(e,t,i),this}get position(){return this.object3d.position}get rotation(){return this.object3d.rotation}add(e){var t;return this.components.push(e),e.entity=this,this.world&&((t=e.init)==null||t.call(e,this,this.world)),this}mesh(e){return this.object3d.add(e),this}get(e){return this.components.find(t=>t instanceof e)??null}}class ti{constructor({heightAt:e,colorAt:t=(_,D,c,f,h)=>h.setHSL(.3,.4,.35),decorate:i=null,tileSize:s=128,rings:a=[[1,48],[2,24],[4,12]],skirt:o=12,anchor:n=null,lookahead:r=.8,buildBudgetMs:l=4,maxBuildsPerFrame:x=4}){this._fn=e,this._colorAt=t,this._decorate=i,this.tileSize=s,this.rings=a,this.skirt=o,this.anchorFn=n,this.lookahead=r,this.buildBudgetMs=l,this.maxBuildsPerFrame=x,this.maxRing=a[a.length-1][0],this._tiles=new Map,this._queue=[],this._prevA=null,this._vel={x:0,z:0},this.tileCount=0,this.builtLastFrame=0}heightAt(e,t){return this._fn(e,t)}slopeAt(e,t,i=1.5){const s=this._fn(e,t);return Math.max(Math.abs(this._fn(e+i,t)-s),Math.abs(this._fn(e,t+i)-s))/i}update(e,{world:t,engine:i,entity:s}){var f;this._entity=s;const a=this.anchorFn?this.anchorFn():t.camera.position,o=Math.floor(a.x/this.tileSize),n=Math.floor(a.z/this.tileSize);if(this._prevA&&e>1e-4){const h=(a.x-this._prevA.x)/e,p=(a.z-this._prevA.z)/e,b=Math.min(1,e*5);this._vel.x+=(h-this._vel.x)*b,this._vel.z+=(p-this._vel.z)*b}this._prevA={x:a.x,z:a.z};const r=this.tileSize*(this.maxRing-.5),l=a.x+Math.max(-r,Math.min(r,this._vel.x*this.lookahead)),x=a.z+Math.max(-r,Math.min(r,this._vel.z*this.lookahead)),_=new Map;for(let h=-this.maxRing;h<=this.maxRing;h++)for(let p=-this.maxRing;p<=this.maxRing;p++){const b=Math.max(Math.abs(p),Math.abs(h)),P=(f=this.rings.find(([S])=>b<=S))==null?void 0:f[1];P!==void 0&&_.set(o+p+","+(n+h),P)}for(const[h,p]of this._tiles)!_.has(h)&&!p.building&&this._dispose(t,h);this._queue.length=0;for(const[h,p]of _){const b=this._tiles.get(h);if(!b||b.res!==p&&!b.building){const[P,S]=h.split(",").map(Number),w=(P+.5)*this.tileSize,T=(S+.5)*this.tileSize,C=Math.hypot(w-l,T-x);this._queue.push({key:h,ix:P,iz:S,res:p,d:C})}}this._queue.sort((h,p)=>h.d-p.d);const D=performance.now();let c=0;for(;this._queue.length&&c<this.maxBuildsPerFrame&&(c===0||performance.now()-D<this.buildBudgetMs);)this._build(t,s,this._queue.shift()),c++;this.builtLastFrame=c,this.tileCount=this._tiles.size}_build(e,t,{key:i,ix:s,iz:a,res:o}){const n=this._tiles.get(i),r=this.tileSize,l=s*r,x=a*r,_=new st,D=o+1,c=D+2,f=new Float32Array(c*c*3),h=new Float32Array(c*c*3),p=new Ge,b=r/o;for(let v=0;v<c;v++)for(let u=0;u<c;u++){const g=Math.min(Math.max(u-1,0),D-1),M=Math.min(Math.max(v-1,0),D-1),m=l+g*b,E=x+M*b,k=u===0||v===0||u===c-1||v===c-1,A=this._fn(m,E),N=(v*c+u)*3;f[N]=m,f[N+1]=k?A-this.skirt:A,f[N+2]=E;const j=this.slopeAt(m,E);this._colorAt(m,E,A,j,p),k&&p.multiplyScalar(.55),h[N]=p.r,h[N+1]=p.g,h[N+2]=p.b}const P=[];for(let v=0;v<c-1;v++)for(let u=0;u<c-1;u++){const g=v*c+u,M=g+1,m=g+c,E=m+1;P.push(g,m,M,M,m,E)}const S=new Float32Array(c*c*3),w=b;for(let v=0;v<c;v++)for(let u=0;u<c;u++){const g=(v*c+u)*3,M=f[g],m=f[g+2],E=(this._fn(M+w,m)-this._fn(M-w,m))/(2*w),k=(this._fn(M,m+w)-this._fn(M,m-w))/(2*w),A=1/Math.hypot(E,1,k);S[g]=-E*A,S[g+1]=A,S[g+2]=-k*A}const T=new et;T.setAttribute("position",new Oe(f,3)),T.setAttribute("normal",new Oe(S,3)),T.setAttribute("color",new Oe(h,3)),T.setIndex(P);const C=new Je(T,ot);C.receiveShadow=!0,_.add(C);const y={key:i,ix:s,iz:a,res:o,group:_,x0:l,z0:x,size:r,colliders:[],cleanup:[],building:!1,addCollider:null};this._decorate&&(y.addCollider=v=>{v.entity=t,v._tileKey=i,y.colliders.push(v)},this._decorate(y,_)),this.onTile&&this.onTile(y,C),n&&this._dispose(e,i,n),t.object3d.add(_);for(const v of y.colliders)t.components.push(v);this._tiles.set(i,y)}_dispose(e,t,i=null){var a;const s=i??this._tiles.get(t);if(s){s.dead=!0;for(const o of s.cleanup??[])o();if((a=s.group.parent)==null||a.remove(s.group),s.group.traverse(o=>{var n,r;o.geometry&&o.geometry.dispose(),o.material&&!o.material._shared&&((r=(n=o.material).dispose)==null||r.call(n))}),s.colliders.length&&this._entity){const o=new Set(s.colliders);this._entity.components=this._entity.components.filter(n=>!o.has(n))}i||this._tiles.delete(t)}}rebuild(e){for(const t of[...this._tiles.keys()])this._dispose(e,t)}}const ot=new Lt({vertexColors:!0,roughness:.95});ot._shared=!0;class $t{constructor({size:e=360}={}){const t=this.canvas=document.createElement("canvas"),i=Math.min(2,typeof window<"u"&&window.devicePixelRatio||1);this.w=e,this.h=e*.72,this.dpr=i,t.width=this.w*i,t.height=this.h*i,Object.assign(t.style,{position:"fixed",left:"50%",top:"50%",transform:"translate(-50%,-50%)",width:this.w+"px",height:this.h+"px",pointerEvents:"none",zIndex:"40",display:"none",opacity:"0.92"}),typeof document<"u"&&document.body.appendChild(t),this.ctx=t.getContext("2d"),this.ctx.scale(i,i),this.visible=!1,this.color="#7dff9e"}show(){this.visible=!0,this.canvas.style.display="block"}hide(){this.visible=!1,this.canvas.style.display="none"}render(e){if(!this.visible)return;const t=this.ctx,i=this.w,s=this.h,a=i/2,o=s/2,n=this.color;t.clearRect(0,0,i,s),t.lineWidth=2,t.strokeStyle=n,t.fillStyle=n,t.font="13px 'Consolas', monospace",t.textBaseline="middle";const r=Math.min(i,s)*.42,l=e.pitch||0,x=e.roll||0,_=r/(Math.PI/3);t.save(),t.beginPath(),t.arc(a,o,r,0,Math.PI*2),t.clip(),t.translate(a,o),t.rotate(-x),t.translate(0,l*_),t.strokeStyle=n,t.fillStyle=n,t.beginPath(),t.moveTo(-r*1.6,0),t.lineTo(r*1.6,0),t.stroke(),t.font="10px 'Consolas', monospace",t.textAlign="center";for(let f=-60;f<=60;f+=10){if(f===0)continue;const h=-f*(Math.PI/180)*_,p=f%20===0?34:18;t.globalAlpha=.75,t.beginPath(),t.moveTo(-p,h),t.lineTo(p,h),t.stroke(),f%20===0&&(t.fillText(Math.abs(f),-p-12,h),t.fillText(Math.abs(f),p+12,h))}t.globalAlpha=1,t.restore(),t.strokeStyle=n,t.globalAlpha=.9,t.beginPath(),t.arc(a,o,r,0,Math.PI*2),t.stroke();for(const f of[-60,-45,-30,-20,-10,0,10,20,30,45,60]){const h=-Math.PI/2+f*Math.PI/180,p=r,b=r-(f%30===0?12:7);t.beginPath(),t.moveTo(a+Math.cos(h)*p,o+Math.sin(h)*p),t.lineTo(a+Math.cos(h)*b,o+Math.sin(h)*b),t.stroke()}t.save(),t.translate(a,o),t.rotate(-x),t.beginPath(),t.moveTo(0,-r),t.lineTo(-6,-r+11),t.lineTo(6,-r+11),t.closePath(),t.fillStyle="#ffd23f",t.fill(),t.restore(),t.strokeStyle="#ffd23f",t.lineWidth=3,t.globalAlpha=1,t.beginPath(),t.moveTo(a-46,o),t.lineTo(a-18,o),t.lineTo(a-10,o+8),t.moveTo(a+46,o),t.lineTo(a+18,o),t.lineTo(a+10,o+8),t.moveTo(a,o-4),t.arc(a,o,3,0,Math.PI*2),t.stroke(),t.lineWidth=2;const D=Math.round((e.speed||0)*3.6),c=Math.round(e.altitude||0);if(this._box(t,6,o,66,`${D}`,"km/h","right"),this._box(t,i-6,o,78,`${c} m`,"ALT","left"),e.heading!=null){let f=Math.round((-e.heading*180/Math.PI%360+360)%360);t.fillStyle=n,t.globalAlpha=.95,t.textAlign="center",t.font="14px 'Consolas', monospace";const h=["N","NE","E","SE","S","SW","W","NW"][Math.round(f/45)%8];t.fillText(`${String(f).padStart(3,"0")}°  ${h}`,a,12)}t.globalAlpha=1}_box(e,t,i,s,a,o,n){const r=this.color,l=30,x=n==="right",_=x?t:t-s;e.globalAlpha=.9,e.strokeStyle=r,e.fillStyle="rgba(0,0,0,0.35)",e.beginPath(),e.rect(_,i-l/2,s,l),e.fill(),e.stroke(),e.fillStyle=r,e.textAlign=x?"left":"right",e.font="16px 'Consolas', monospace",e.fillText(a,x?_+6:_+s-6,i),e.font="9px 'Consolas', monospace",e.globalAlpha=.7,e.textAlign="center",e.fillText(o,_+s/2,i-l/2-7),e.globalAlpha=1}dispose(){this.canvas.remove()}}typeof window<"u"&&(window.FlightHUD=$t);class ne{constructor({world:e}={}){this.world=e,this.active=!1,this.carIdx=0,this.side="front",this.yaw=.7,this.pitch=.45,this.dist=9,this._drag=null,this._buildUI(),window.addEventListener("keydown",t=>{t.code==="KeyV"&&!t.repeat&&this.toggle()}),window.addEventListener("mousedown",t=>{this.active&&t.target.tagName==="CANVAS"&&(this._drag=[t.clientX,t.clientY])}),window.addEventListener("mouseup",()=>this._drag=null),window.addEventListener("mousemove",t=>{!this.active||!this._drag||(this.yaw-=(t.clientX-this._drag[0])*.008,this.pitch=Qe.clamp(this.pitch+(t.clientY-this._drag[1])*.006,.05,1.35),this._drag=[t.clientX,t.clientY])}),window.addEventListener("wheel",t=>{this.active&&(this.dist=Qe.clamp(this.dist+Math.sign(t.deltaY)*.8,4,25))})}get car(){var t,i;const e=((t=window.__pf)==null?void 0:t.cars)??[];return e.length?((i=window.__pf)==null?void 0:i.drivingCar)??e[Math.abs(this.carIdx)%e.length]:null}get dmgSys(){return window.__pfDamage??null}_vb(e){var t;return(t=e==null?void 0:e.components)==null?void 0:t.find(i=>i.rb&&i.suspension)}toggle(e=!this.active){var t;this.active=e,(t=document.exitPointerLock)==null||t.call(document),this.btn.classList.toggle("pf-on",e),this.panel.style.display=e?"block":"none",e&&(this._refresh(),this._syncSliders())}_hit(e){const t=this.car;t&&this.dmgSys&&(this.dmgSys.testHit(t,e,this.side),this._refresh())}_cycleWheel(e){var o,n,r,l,x,_;const t=this._vb(this.car);if(!t)return;const i=!!((o=t._flat)!=null&&o[e]),s=!!((n=t._locked)!=null&&n[e]);!!((r=t._detached)!=null&&r[e])?(t.setWheelDetached(e,!1),t.setWheelLocked(e,!1),(l=t.setWheelFlat)==null||l.call(t,e,!1)):s?(t.setWheelLocked(e,!1),t.setWheelDetached(e,!0)):i?((x=t.setWheelFlat)==null||x.call(t,e,!1),t.setWheelLocked(e,!0)):(_=t.setWheelFlat)==null||_.call(t,e,!0),this._refresh()}_refresh(){const e=this.car,t=this._vb(e);this.panel.querySelector("[data-car]").textContent=e?`${e.specName??"car"} · dmg ${(e.damage??0).toFixed(1)} · smoke ${(e.smokeDmg??0).toFixed(1)}`:"(no car)",this.panel.querySelectorAll("[data-side]").forEach(s=>s.classList.toggle("pf-sel",s.dataset.side===this.side));const i=["FL","FR","RL","RR"];this.panel.querySelectorAll("[data-wheel]").forEach(s=>{var n,r,l;const a=+s.dataset.wheel,o=(n=t==null?void 0:t._detached)!=null&&n[a]?"OFF":(r=t==null?void 0:t._locked)!=null&&r[a]?"LOCK":(l=t==null?void 0:t._flat)!=null&&l[a]?"FLAT":"ok";s.textContent=`${i[a]}: ${o}`,s.classList.toggle("pf-sel",o!=="ok")})}update(){var a;if(!this.active)return;document.pointerLockElement&&((a=document.exitPointerLock)==null||a.call(document));const e=this.car;if(!(e!=null&&e.position))return;const t=this.world.camera,i=Math.cos(this.pitch),s=Math.sin(this.pitch);t.position.set(e.position.x+Math.cos(this.yaw)*i*this.dist,e.position.y+s*this.dist,e.position.z+Math.sin(this.yaw)*i*this.dist),t.lookAt(e.position.x,e.position.y+.6,e.position.z),(this._t=(this._t??0)+1)%30===0&&this._refresh()}_buildUI(){if(!document.getElementById("pf-vtest-css")){const e=document.createElement("style");e.id="pf-vtest-css",e.textContent=`
        .pf-vtest-btn { position: fixed; top: 46px; left: 148px; z-index: 30; padding: 8px 12px;
          background: rgba(20,24,32,.85); color: #fff; border: 1px solid rgba(255,255,255,.25);
          border-radius: 8px; font: 600 13px system-ui; cursor: pointer; }
        .pf-vtest-btn.pf-on { background: rgba(230,120,40,.85); }
        .pf-vtest-panel { position: fixed; top: 92px; left: 10px; z-index: 30; width: 234px;
          max-height: calc(100vh - 110px); overflow-y: auto;
          background: rgba(20,24,32,.88); color: #fff; border: 1px solid rgba(255,255,255,.2);
          border-radius: 10px; padding: 10px; font: 500 12px system-ui; }
        .pf-vtest-panel label.pf-slide { display: flex; align-items: center; gap: 6px; margin: 3px 0; font-size: 11px; }
        .pf-vtest-panel label.pf-slide b { width: 78px; opacity: .72; font-weight: 600; }
        .pf-vtest-panel label.pf-slide input[type=range] { flex: 1; accent-color: #e67828; min-width: 0; }
        .pf-vtest-panel label.pf-slide span { width: 32px; text-align: right; opacity: .85; font-variant-numeric: tabular-nums; }
        .pf-vtest-panel h4 { margin: 6px 0 4px; font-size: 11px; opacity: .7; text-transform: uppercase; }
        .pf-vtest-panel button { display: inline-block; margin: 2px 2px 2px 0; padding: 6px 8px;
          background: rgba(255,255,255,.08); color: #fff; border: 1px solid rgba(255,255,255,.18);
          border-radius: 6px; font: 600 11px system-ui; cursor: pointer; }
        .pf-vtest-panel button:hover { background: rgba(255,255,255,.16); }
        .pf-vtest-panel button.pf-sel { background: rgba(230,120,40,.5); }
        .pf-vtest-panel .pf-row { margin-bottom: 2px; }`,document.head.appendChild(e)}this.btn=document.createElement("button"),this.btn.className="pf-vtest-btn",this.btn.textContent="🚗 CAR (V)",this.btn.addEventListener("click",()=>this.toggle()),document.body.appendChild(this.btn),this.panel=document.createElement("div"),this.panel.className="pf-vtest-panel",this.panel.style.display="none",this.panel.innerHTML=`
      <div data-car style="margin-bottom:6px;font-weight:700"></div>
      <h4>hit side</h4>
      <div class="pf-row">
        <button data-side="front">front</button><button data-side="rear">rear</button>
        <button data-side="left">left</button><button data-side="right">right</button>
      </div>
      <h4>crash</h4>
      <div class="pf-row">
        <button data-sev="1">light</button><button data-sev="5">hard</button><button data-sev="25">💀 total</button>
      </div>
      <h4>wheels (click to cycle)</h4>
      <div class="pf-row">
        <button data-wheel="0"></button><button data-wheel="1"></button>
        <button data-wheel="2"></button><button data-wheel="3"></button>
      </div>
      <h4>smoke</h4>
      <div class="pf-row">
        <button data-smoke="0">clean</button><button data-smoke="12">wisps</button><button data-smoke="30">plume</button>
      </div>
      <h4>🎛️ tuning · live · all cars</h4>
      <label class="pf-slide"><b>Engine</b><input type="range" data-knob="enginePower" min="4" max="24" step="0.5"><span data-kv="enginePower"></span></label>
      <label class="pf-slide"><b>Top speed</b><input type="range" data-knob="topSpeed" min="15" max="70" step="1"><span data-kv="topSpeed"></span></label>
      <label class="pf-slide"><b>Brakes</b><input type="range" data-knob="brakePower" min="5" max="30" step="0.5"><span data-kv="brakePower"></span></label>
      <label class="pf-slide"><b>Grip</b><input type="range" data-knob="sideFriction" min="0.3" max="1.5" step="0.05"><span data-kv="sideFriction"></span></label>
      <label class="pf-slide"><b>Drift (rear)</b><input type="range" data-knob="rearGripMul" min="0.3" max="1.6" step="0.05"><span data-kv="rearGripMul"></span></label>
      <label class="pf-slide"><b>Air hang</b><input type="range" data-knob="_airGrav" min="0" max="1" step="0.05"><span data-kv="_airGrav"></span></label>
      <label class="pf-slide"><b>Suspension</b><input type="range" data-knob="suspStiff" min="15" max="70" step="1"><span data-kv="suspStiff"></span></label>
      <div class="pf-row" style="margin-top:4px"><button data-act="tunereset">↺ reset tuning</button></div>
      <div class="pf-row" style="margin-top:8px">
        <button data-act="reset">♻ reset car</button>
      </div>`,this.panel.addEventListener("click",e=>{const t=e.target.closest("button");if(t){if(t.dataset.side)this.side=t.dataset.side;else if(t.dataset.sev)this._hit(+t.dataset.sev);else if(t.dataset.wheel)this._cycleWheel(+t.dataset.wheel);else if(t.dataset.smoke!==void 0){const i=this.car;i&&(i.smokeDmg=+t.dataset.smoke)}else if(t.dataset.act==="reset"){const i=this.car;i&&this.dmgSys&&this.dmgSys.resetCar(i)}else if(t.dataset.act==="tunereset"){for(const[i,s]of Object.entries(ne.KNOB_DEFAULTS))this._setKnob(i,s);this._syncSliders()}this._refresh()}}),this.panel.addEventListener("input",e=>{const t=e.target.closest("input[type=range]");if(!t)return;const i=t.dataset.knob,s=+t.value;this._setKnob(i,s),this._kvText(i,s)}),document.body.appendChild(this.panel)}_kvText(e,t){const i=e==="sideFriction"||e==="rearGripMul"||e==="_airGrav",s=this.panel.querySelector(`[data-kv="${e}"]`);s&&(s.textContent=(+t).toFixed(i?2:0))}_setKnob(e,t){var i,s,a;for(const o of((i=window.__pf)==null?void 0:i.cars)??[]){const n=(s=o.components)==null?void 0:s.find(r=>r.rb&&r.suspension);if(n)if(e==="suspStiff"){n.suspStiff=t;for(let r=0;r<4;r++)(a=n.ctrl)==null||a.setWheelSuspensionStiffness(r,t)}else n[e]=t}}_syncSliders(){const e=this._vb(this.car);if(e)for(const t of Object.keys(ne.KNOB_DEFAULTS)){const i=t==="_airGrav"?e._airGrav??ne.KNOB_DEFAULTS._airGrav:e[t];if(i==null)continue;const s=this.panel.querySelector(`input[data-knob="${t}"]`);s&&(s.value=i),this._kvText(t,i)}}}ne.KNOB_DEFAULTS={enginePower:10,topSpeed:38,brakePower:15,sideFriction:.8,rearGripMul:1,_airGrav:.5,suspStiff:42};export{Ke as E,$t as F,ti as S,ne as V,ei as W};
