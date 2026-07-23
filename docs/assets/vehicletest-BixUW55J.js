var vt=Object.defineProperty;var gt=(m,e,t)=>e in m?vt(m,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):m[e]=t;var Be=(m,e,t)=>gt(m,typeof e!="symbol"?e+"":e,t);import{m as ot,ap as _t,B as at,h as Ke,S as X,aq as Z,q as ye,ar as qe,as as Ye,at as B,au as xt,C as Xe,V as R,M as we,av as nt,R as be,aw as wt,ax as ue,ay as me,az as $e,aA as Je,aB as Mt,aC as yt,aD as bt,aE as St,aF as et,aG as Pt,aH as Tt,aI as Ct,p as Et,aJ as Rt,aK as Dt,aL as At,aM as Nt,aN as rt,aO as kt,aP as zt,aQ as Ut,ah as Ft,ai as It,aj as Lt,ak as Vt,G as lt,f as Q,u as Ot,Q as tt,Y as Ge,e as F,a6 as Bt,a as je}from"./GLTFLoader-hZLJDLGd.js";class Gt{constructor(e){this.target=e,this._keys=new Set,this._pressed=new Set,this._released=new Set,this._bindings=new Map,this.pointer={x:0,y:0,dx:0,dy:0,down:!1,rightDown:!1,wheel:0},this._sticks={left:{id:null,ox:0,oy:0,x:0,y:0},right:{id:null,ox:0,oy:0,x:0,y:0}},this._h=[];const t=(i,s,o,a)=>{i.addEventListener(s,o,a),this._h.push([i,s,o])};t(window,"keydown",i=>{i.repeat||(this._keys.add(i.code),this._pressed.add(i.code))}),t(window,"keyup",i=>{this._keys.delete(i.code),this._released.add(i.code)}),t(window,"blur",()=>this._keys.clear()),t(e,"pointerdown",i=>{if(i.pointerType==="touch")return this._touchStart(i);i.button===0&&(this.pointer.down=!0,this._pressed.add("Mouse0")),i.button===2&&(this.pointer.rightDown=!0,this._pressed.add("Mouse2"))}),t(window,"pointerup",i=>{if(i.pointerType==="touch")return this._touchEnd(i);i.button===0&&(this.pointer.down=!1,this._released.add("Mouse0")),i.button===2&&(this.pointer.rightDown=!1,this._released.add("Mouse2"))}),t(window,"pointermove",i=>{if(i.pointerType==="touch")return this._touchMove(i);this.pointer.dx+=i.movementX,this.pointer.dy+=i.movementY;const s=e.getBoundingClientRect();this.pointer.x=i.clientX-s.left,this.pointer.y=i.clientY-s.top;const o=!!(i.buttons&1),a=!!(i.buttons&2);o!==this.pointer.down&&(this.pointer.down=o,this[o?"_pressed":"_released"].add("Mouse0")),a!==this.pointer.rightDown&&(this.pointer.rightDown=a,this[a?"_pressed":"_released"].add("Mouse2"))}),t(e,"wheel",i=>{this.pointer.wheel+=Math.sign(i.deltaY),i.preventDefault()},{passive:!1}),t(e,"contextmenu",i=>i.preventDefault())}enablePointerLock(){const e=()=>{window.__pfTest&&window.__pfTest.active&&!window.__pfTest.livePlay||document.pointerLockElement!==this.target&&this.target.requestPointerLock()};this.target.addEventListener("pointerdown",e),this._h.push([this.target,"pointerdown",e])}get pointerLocked(){return document.pointerLockElement===this.target}bind(e,t){this._bindings.set(e,t)}down(e){return this._keys.has(e)}pressed(e){return(this._bindings.get(e)??[e]).some(i=>this._pressed.has(i))}released(e){return(this._bindings.get(e)??[e]).some(i=>this._released.has(i))}held(e){return(this._bindings.get(e)??[e]).some(i=>this._keys.has(i))}axis(e,t){return(this.down(t)?1:0)-(this.down(e)?1:0)}stick(e){const t=this._sticks[e];return{x:t.x,y:t.y}}_touchStart(e){const t=this.target.getBoundingClientRect(),i=e.clientX-t.left<t.width/2?"left":"right",s=this._sticks[i];s.id===null&&(s.id=e.pointerId,s.ox=e.clientX,s.oy=e.clientY,s.x=s.y=0)}_touchMove(e){for(const t of Object.values(this._sticks)){if(t.id!==e.pointerId)continue;const i=60;t.x=Math.max(-1,Math.min(1,(e.clientX-t.ox)/i)),t.y=Math.max(-1,Math.min(1,(e.clientY-t.oy)/i))}}_touchEnd(e){for(const t of Object.values(this._sticks))t.id===e.pointerId&&(t.id=null,t.x=t.y=0)}endFrame(){this._pressed.clear(),this._released.clear(),this.pointer.dx=this.pointer.dy=0,this.pointer.wheel=0}dispose(){for(const[e,t,i]of this._h)e.removeEventListener(t,i)}}const K=[],$=[],jt={update(m){var e;for(let t=K.length-1;t>=0;t--){const i=K[t];if(i.dead){K.splice(t,1);continue}if(i.delay>0){i.delay-=m;continue}i.t=Math.min(i.t+m/i.dur,1);const s=i.ease(i.forward?i.t:1-i.t);for(const o of Object.keys(i.to))i.obj[o]=i.from[o]+(i.to[o]-i.from[o])*s;if(i.t>=1){if(i.yoyo&&i.forward){i.forward=!1,i.t=0;continue}if(i.repeat>0||i.repeat===1/0){i.repeat!==1/0&&i.repeat--,i.forward=!0,i.t=0;continue}(e=i.onDone)==null||e.call(i),K.splice(t,1)}}for(let t=$.length-1;t>=0;t--){const i=$[t];if(i.dead){$.splice(t,1);continue}i.left-=m,i.left<=0&&(i.fn(),i.repeat?i.left=i.sec:$.splice(t,1))}},clear(){K.length=0,$.length=0},get count(){return K.length+$.length}},Me={name:"CopyShader",uniforms:{tDiffuse:{value:null},opacity:{value:1}},vertexShader:`

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


		}`};class J{constructor(){this.isPass=!0,this.enabled=!0,this.needsSwap=!0,this.clear=!1,this.renderToScreen=!1}setSize(){}render(){console.error("THREE.Pass: .render() must be implemented in derived pass.")}dispose(){}}const Ht=new _t(-1,1,1,-1,0,1);class Wt extends at{constructor(){super(),this.setAttribute("position",new Ke([-1,3,0,-1,-1,0,3,-1,0],3)),this.setAttribute("uv",new Ke([0,2,0,0,2,0],2))}}const qt=new Wt;class Ze{constructor(e){this._mesh=new ot(qt,e)}dispose(){this._mesh.geometry.dispose()}render(e){e.render(this._mesh,Ht)}get material(){return this._mesh.material}set material(e){this._mesh.material=e}}class Yt extends J{constructor(e,t="tDiffuse"){super(),this.textureID=t,this.uniforms=null,this.material=null,e instanceof X?(this.uniforms=e.uniforms,this.material=e):e&&(this.uniforms=Z.clone(e.uniforms),this.material=new X({name:e.name!==void 0?e.name:"unspecified",defines:Object.assign({},e.defines),uniforms:this.uniforms,vertexShader:e.vertexShader,fragmentShader:e.fragmentShader})),this._fsQuad=new Ze(this.material)}render(e,t,i){this.uniforms[this.textureID]&&(this.uniforms[this.textureID].value=i.texture),this._fsQuad.material=this.material,this.renderToScreen?(e.setRenderTarget(null),this._fsQuad.render(e)):(e.setRenderTarget(t),this.clear&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),this._fsQuad.render(e))}dispose(){this.material.dispose(),this._fsQuad.dispose()}}class it extends J{constructor(e,t){super(),this.scene=e,this.camera=t,this.clear=!0,this.needsSwap=!1,this.inverse=!1}render(e,t,i){const s=e.getContext(),o=e.state;o.buffers.color.setMask(!1),o.buffers.depth.setMask(!1),o.buffers.color.setLocked(!0),o.buffers.depth.setLocked(!0);let a,n;this.inverse?(a=0,n=1):(a=1,n=0),o.buffers.stencil.setTest(!0),o.buffers.stencil.setOp(s.REPLACE,s.REPLACE,s.REPLACE),o.buffers.stencil.setFunc(s.ALWAYS,a,4294967295),o.buffers.stencil.setClear(n),o.buffers.stencil.setLocked(!0),e.setRenderTarget(i),this.clear&&e.clear(),e.render(this.scene,this.camera),e.setRenderTarget(t),this.clear&&e.clear(),e.render(this.scene,this.camera),o.buffers.color.setLocked(!1),o.buffers.depth.setLocked(!1),o.buffers.color.setMask(!0),o.buffers.depth.setMask(!0),o.buffers.stencil.setLocked(!1),o.buffers.stencil.setFunc(s.EQUAL,1,4294967295),o.buffers.stencil.setOp(s.KEEP,s.KEEP,s.KEEP),o.buffers.stencil.setLocked(!0)}}class Xt extends J{constructor(){super(),this.needsSwap=!1}render(e){e.state.buffers.stencil.setLocked(!1),e.state.buffers.stencil.setTest(!1)}}class Zt{constructor(e,t){if(this.renderer=e,this._pixelRatio=e.getPixelRatio(),t===void 0){const i=e.getSize(new ye);this._width=i.width,this._height=i.height,t=new qe(this._width*this._pixelRatio,this._height*this._pixelRatio,{type:Ye}),t.texture.name="EffectComposer.rt1"}else this._width=t.width,this._height=t.height;this.renderTarget1=t,this.renderTarget2=t.clone(),this.renderTarget2.texture.name="EffectComposer.rt2",this.writeBuffer=this.renderTarget1,this.readBuffer=this.renderTarget2,this.renderToScreen=!0,this.passes=[],this.copyPass=new Yt(Me),this.copyPass.material.blending=B,this.timer=new xt}swapBuffers(){const e=this.readBuffer;this.readBuffer=this.writeBuffer,this.writeBuffer=e}addPass(e){this.passes.push(e),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}insertPass(e,t){this.passes.splice(t,0,e),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}removePass(e){const t=this.passes.indexOf(e);t!==-1&&this.passes.splice(t,1)}isLastEnabledPass(e){for(let t=e+1;t<this.passes.length;t++)if(this.passes[t].enabled)return!1;return!0}render(e){this.timer.update(),e===void 0&&(e=this.timer.getDelta());const t=this.renderer.getRenderTarget();let i=!1;for(let s=0,o=this.passes.length;s<o;s++){const a=this.passes[s];if(a.enabled!==!1){if(a.renderToScreen=this.renderToScreen&&this.isLastEnabledPass(s),a.render(this.renderer,this.writeBuffer,this.readBuffer,e,i),a.needsSwap){if(i){const n=this.renderer.getContext(),r=this.renderer.state.buffers.stencil;r.setFunc(n.NOTEQUAL,1,4294967295),this.copyPass.render(this.renderer,this.writeBuffer,this.readBuffer,e),r.setFunc(n.EQUAL,1,4294967295)}this.swapBuffers()}it!==void 0&&(a instanceof it?i=!0:a instanceof Xt&&(i=!1))}}this.renderer.setRenderTarget(t)}reset(e){if(e===void 0){const t=this.renderer.getSize(new ye);this._pixelRatio=this.renderer.getPixelRatio(),this._width=t.width,this._height=t.height,e=this.renderTarget1.clone(),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}this.renderTarget1.dispose(),this.renderTarget2.dispose(),this.renderTarget1=e,this.renderTarget2=e.clone(),this.writeBuffer=this.renderTarget1,this.readBuffer=this.renderTarget2}setSize(e,t){this._width=e,this._height=t;const i=this._width*this._pixelRatio,s=this._height*this._pixelRatio;this.renderTarget1.setSize(i,s),this.renderTarget2.setSize(i,s);for(let o=0;o<this.passes.length;o++)this.passes[o].setSize(i,s)}setPixelRatio(e){this._pixelRatio=e,this.setSize(this._width,this._height)}dispose(){this.renderTarget1.dispose(),this.renderTarget2.dispose(),this.copyPass.dispose()}}class Qt extends J{constructor(e,t,i=null,s=null,o=null){super(),this.scene=e,this.camera=t,this.overrideMaterial=i,this.clearColor=s,this.clearAlpha=o,this.clear=!0,this.clearDepth=!1,this.needsSwap=!1,this.isRenderPass=!0,this._oldClearColor=new Xe}render(e,t,i){const s=e.autoClear;e.autoClear=!1;let o,a;this.overrideMaterial!==null&&(a=this.scene.overrideMaterial,this.scene.overrideMaterial=this.overrideMaterial),this.clearColor!==null&&(e.getClearColor(this._oldClearColor),e.setClearColor(this.clearColor,e.getClearAlpha())),this.clearAlpha!==null&&(o=e.getClearAlpha(),e.setClearAlpha(this.clearAlpha)),this.clearDepth==!0&&e.clearDepth(),e.setRenderTarget(this.renderToScreen?null:i),this.clear===!0&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),e.render(this.scene,this.camera),this.clearColor!==null&&e.setClearColor(this._oldClearColor),this.clearAlpha!==null&&e.setClearAlpha(o),this.overrideMaterial!==null&&(this.scene.overrideMaterial=a),e.autoClear=s}}const ve={defines:{PERSPECTIVE_CAMERA:1,SAMPLES:16,NORMAL_VECTOR_TYPE:1,DEPTH_SWIZZLING:"x",SCREEN_SPACE_RADIUS:0,SCREEN_SPACE_RADIUS_SCALE:100,SCENE_CLIP_BOX:0},uniforms:{tNormal:{value:null},tDepth:{value:null},tNoise:{value:null},resolution:{value:new ye},cameraNear:{value:null},cameraFar:{value:null},cameraProjectionMatrix:{value:new we},cameraProjectionMatrixInverse:{value:new we},cameraWorldMatrix:{value:new we},radius:{value:.25},distanceExponent:{value:1},thickness:{value:1},distanceFallOff:{value:1},scale:{value:1},sceneBoxMin:{value:new R(-1,-1,-1)},sceneBoxMax:{value:new R(1,1,1)}},vertexShader:`

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
		}`},ge={defines:{PERSPECTIVE_CAMERA:1},uniforms:{tDepth:{value:null},cameraNear:{value:null},cameraFar:{value:null}},vertexShader:`
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

		}`},He={uniforms:{tDiffuse:{value:null},intensity:{value:1}},vertexShader:`
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
		}`};function Kt(m=5){const e=Math.floor(m)%2===0?Math.floor(m)+1:Math.floor(m),t=$t(e),i=t.length,s=new Uint8Array(i*4);for(let a=0;a<i;++a){const n=t[a],r=2*Math.PI*n/i,l=new R(Math.cos(r),Math.sin(r),0).normalize();s[a*4]=(l.x*.5+.5)*255,s[a*4+1]=(l.y*.5+.5)*255,s[a*4+2]=127,s[a*4+3]=255}const o=new nt(s,e,e);return o.wrapS=be,o.wrapT=be,o.needsUpdate=!0,o}function $t(m){const e=Math.floor(m)%2===0?Math.floor(m)+1:Math.floor(m),t=e*e,i=Array(t).fill(0);let s=Math.floor(e/2),o=e-1;for(let a=1;a<=t;){if(s===-1&&o===e?(o=e-2,s=0):(o===e&&(o=0),s<0&&(s=e-1)),i[s*e+o]!==0){o-=2,s++;continue}else i[s*e+o]=a++;o++,s--}return i}const _e={defines:{SAMPLES:16,SAMPLE_VECTORS:ht(16,2,1),NORMAL_VECTOR_TYPE:1,DEPTH_VALUE_SOURCE:0},uniforms:{tDiffuse:{value:null},tNormal:{value:null},tDepth:{value:null},tNoise:{value:null},resolution:{value:new ye},cameraProjectionMatrixInverse:{value:new we},lumaPhi:{value:5},depthPhi:{value:5},normalPhi:{value:5},radius:{value:4},index:{value:0}},vertexShader:`

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
		}`};function ht(m,e,t){const i=Jt(m,e,t);let s="vec3[SAMPLES](";for(let o=0;o<m;o++){const a=i[o];s+=`vec3(${a.x}, ${a.y}, ${a.z})${o<m-1?",":")"}`}return s}function Jt(m,e,t){const i=[];for(let s=0;s<m;s++){const o=2*Math.PI*e*s/m,a=Math.pow(s/(m-1),t);i.push(new R(Math.cos(o),Math.sin(o),a))}return i}class ei{constructor(e=Math){this.grad3=[[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]],this.grad4=[[0,1,1,1],[0,1,1,-1],[0,1,-1,1],[0,1,-1,-1],[0,-1,1,1],[0,-1,1,-1],[0,-1,-1,1],[0,-1,-1,-1],[1,0,1,1],[1,0,1,-1],[1,0,-1,1],[1,0,-1,-1],[-1,0,1,1],[-1,0,1,-1],[-1,0,-1,1],[-1,0,-1,-1],[1,1,0,1],[1,1,0,-1],[1,-1,0,1],[1,-1,0,-1],[-1,1,0,1],[-1,1,0,-1],[-1,-1,0,1],[-1,-1,0,-1],[1,1,1,0],[1,1,-1,0],[1,-1,1,0],[1,-1,-1,0],[-1,1,1,0],[-1,1,-1,0],[-1,-1,1,0],[-1,-1,-1,0]],this.p=[];for(let t=0;t<256;t++)this.p[t]=Math.floor(e.random()*256);this.perm=[];for(let t=0;t<512;t++)this.perm[t]=this.p[t&255];this.simplex=[[0,1,2,3],[0,1,3,2],[0,0,0,0],[0,2,3,1],[0,0,0,0],[0,0,0,0],[0,0,0,0],[1,2,3,0],[0,2,1,3],[0,0,0,0],[0,3,1,2],[0,3,2,1],[0,0,0,0],[0,0,0,0],[0,0,0,0],[1,3,2,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[1,2,0,3],[0,0,0,0],[1,3,0,2],[0,0,0,0],[0,0,0,0],[0,0,0,0],[2,3,0,1],[2,3,1,0],[1,0,2,3],[1,0,3,2],[0,0,0,0],[0,0,0,0],[0,0,0,0],[2,0,3,1],[0,0,0,0],[2,1,3,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[2,0,1,3],[0,0,0,0],[0,0,0,0],[0,0,0,0],[3,0,1,2],[3,0,2,1],[0,0,0,0],[3,1,2,0],[2,1,0,3],[0,0,0,0],[0,0,0,0],[0,0,0,0],[3,1,0,2],[0,0,0,0],[3,2,0,1],[3,2,1,0]]}noise(e,t){let i,s,o;const a=.5*(Math.sqrt(3)-1),n=(e+t)*a,r=Math.floor(e+n),l=Math.floor(t+n),d=(3-Math.sqrt(3))/6,f=(r+l)*d,_=r-f,c=l-f,h=e-_,M=t-c;let T,S;h>M?(T=1,S=0):(T=0,S=1);const E=h-T+d,C=M-S+d,x=h-1+2*d,P=M-1+2*d,D=r&255,b=l&255,y=this.perm[D+this.perm[b]]%12,u=this.perm[D+T+this.perm[b+S]]%12,p=this.perm[D+1+this.perm[b+1]]%12;let v=.5-h*h-M*M;v<0?i=0:(v*=v,i=v*v*this._dot(this.grad3[y],h,M));let w=.5-E*E-C*C;w<0?s=0:(w*=w,s=w*w*this._dot(this.grad3[u],E,C));let g=.5-x*x-P*P;return g<0?o=0:(g*=g,o=g*g*this._dot(this.grad3[p],x,P)),70*(i+s+o)}noise3d(e,t,i){let s,o,a,n;const l=(e+t+i)*.3333333333333333,d=Math.floor(e+l),f=Math.floor(t+l),_=Math.floor(i+l),c=1/6,h=(d+f+_)*c,M=d-h,T=f-h,S=_-h,E=e-M,C=t-T,x=i-S;let P,D,b,y,u,p;E>=C?C>=x?(P=1,D=0,b=0,y=1,u=1,p=0):E>=x?(P=1,D=0,b=0,y=1,u=0,p=1):(P=0,D=0,b=1,y=1,u=0,p=1):C<x?(P=0,D=0,b=1,y=0,u=1,p=1):E<x?(P=0,D=1,b=0,y=0,u=1,p=1):(P=0,D=1,b=0,y=1,u=1,p=0);const v=E-P+c,w=C-D+c,g=x-b+c,U=E-y+2*c,z=C-u+2*c,A=x-p+2*c,k=E-1+3*c,L=C-1+3*c,N=x-1+3*c,I=d&255,O=f&255,Y=_&255,ce=this.perm[I+this.perm[O+this.perm[Y]]]%12,de=this.perm[I+P+this.perm[O+D+this.perm[Y+b]]]%12,fe=this.perm[I+y+this.perm[O+u+this.perm[Y+p]]]%12,pe=this.perm[I+1+this.perm[O+1+this.perm[Y+1]]]%12;let j=.6-E*E-C*C-x*x;j<0?s=0:(j*=j,s=j*j*this._dot3(this.grad3[ce],E,C,x));let H=.6-v*v-w*w-g*g;H<0?o=0:(H*=H,o=H*H*this._dot3(this.grad3[de],v,w,g));let W=.6-U*U-z*z-A*A;W<0?a=0:(W*=W,a=W*W*this._dot3(this.grad3[fe],U,z,A));let q=.6-k*k-L*L-N*N;return q<0?n=0:(q*=q,n=q*q*this._dot3(this.grad3[pe],k,L,N)),32*(s+o+a+n)}noise4d(e,t,i,s){const o=this.grad4,a=this.simplex,n=this.perm,r=(Math.sqrt(5)-1)/4,l=(5-Math.sqrt(5))/20;let d,f,_,c,h;const M=(e+t+i+s)*r,T=Math.floor(e+M),S=Math.floor(t+M),E=Math.floor(i+M),C=Math.floor(s+M),x=(T+S+E+C)*l,P=T-x,D=S-x,b=E-x,y=C-x,u=e-P,p=t-D,v=i-b,w=s-y,g=u>p?32:0,U=u>v?16:0,z=p>v?8:0,A=u>w?4:0,k=p>w?2:0,L=v>w?1:0,N=g+U+z+A+k+L,I=a[N][0]>=3?1:0,O=a[N][1]>=3?1:0,Y=a[N][2]>=3?1:0,ce=a[N][3]>=3?1:0,de=a[N][0]>=2?1:0,fe=a[N][1]>=2?1:0,pe=a[N][2]>=2?1:0,j=a[N][3]>=2?1:0,H=a[N][0]>=1?1:0,W=a[N][1]>=1?1:0,q=a[N][2]>=1?1:0,Qe=a[N][3]>=1?1:0,Pe=u-I+l,Te=p-O+l,Ce=v-Y+l,Ee=w-ce+l,Re=u-de+2*l,De=p-fe+2*l,Ae=v-pe+2*l,Ne=w-j+2*l,ke=u-H+3*l,ze=p-W+3*l,Ue=v-q+3*l,Fe=w-Qe+3*l,Ie=u-1+4*l,Le=p-1+4*l,Ve=v-1+4*l,Oe=w-1+4*l,ee=T&255,te=S&255,ie=E&255,se=C&255,dt=n[ee+n[te+n[ie+n[se]]]]%32,ft=n[ee+I+n[te+O+n[ie+Y+n[se+ce]]]]%32,pt=n[ee+de+n[te+fe+n[ie+pe+n[se+j]]]]%32,ut=n[ee+H+n[te+W+n[ie+q+n[se+Qe]]]]%32,mt=n[ee+1+n[te+1+n[ie+1+n[se+1]]]]%32;let oe=.6-u*u-p*p-v*v-w*w;oe<0?d=0:(oe*=oe,d=oe*oe*this._dot4(o[dt],u,p,v,w));let ae=.6-Pe*Pe-Te*Te-Ce*Ce-Ee*Ee;ae<0?f=0:(ae*=ae,f=ae*ae*this._dot4(o[ft],Pe,Te,Ce,Ee));let ne=.6-Re*Re-De*De-Ae*Ae-Ne*Ne;ne<0?_=0:(ne*=ne,_=ne*ne*this._dot4(o[pt],Re,De,Ae,Ne));let re=.6-ke*ke-ze*ze-Ue*Ue-Fe*Fe;re<0?c=0:(re*=re,c=re*re*this._dot4(o[ut],ke,ze,Ue,Fe));let le=.6-Ie*Ie-Le*Le-Ve*Ve-Oe*Oe;return le<0?h=0:(le*=le,h=le*le*this._dot4(o[mt],Ie,Le,Ve,Oe)),27*(d+f+_+c+h)}_dot(e,t,i){return e[0]*t+e[1]*i}_dot3(e,t,i,s){return e[0]*t+e[1]*i+e[2]*s}_dot4(e,t,i,s,o){return e[0]*t+e[1]*i+e[2]*s+e[3]*o}}class V extends J{constructor(e,t,i=512,s=512,o,a,n){super(),this.width=i,this.height=s,this.clear=!0,this.camera=t,this.scene=e,this.output=0,this._renderGBuffer=!0,this._visibilityCache=[],this.blendIntensity=1,this.pdRings=2,this.pdRadiusExponent=2,this.pdSamples=16,this.gtaoNoiseTexture=Kt(),this.pdNoiseTexture=this._generateNoise(),this.gtaoRenderTarget=new qe(this.width,this.height,{type:Ye}),this.pdRenderTarget=this.gtaoRenderTarget.clone(),this.gtaoMaterial=new X({defines:Object.assign({},ve.defines),uniforms:Z.clone(ve.uniforms),vertexShader:ve.vertexShader,fragmentShader:ve.fragmentShader,blending:B,depthTest:!1,depthWrite:!1}),this.gtaoMaterial.defines.PERSPECTIVE_CAMERA=this.camera.isPerspectiveCamera?1:0,this.gtaoMaterial.uniforms.tNoise.value=this.gtaoNoiseTexture,this.gtaoMaterial.uniforms.resolution.value.set(this.width,this.height),this.gtaoMaterial.uniforms.cameraNear.value=this.camera.near,this.gtaoMaterial.uniforms.cameraFar.value=this.camera.far,this.normalMaterial=new wt,this.normalMaterial.blending=B,this.pdMaterial=new X({defines:Object.assign({},_e.defines),uniforms:Z.clone(_e.uniforms),vertexShader:_e.vertexShader,fragmentShader:_e.fragmentShader,depthTest:!1,depthWrite:!1}),this.pdMaterial.uniforms.tDiffuse.value=this.gtaoRenderTarget.texture,this.pdMaterial.uniforms.tNoise.value=this.pdNoiseTexture,this.pdMaterial.uniforms.resolution.value.set(this.width,this.height),this.pdMaterial.uniforms.lumaPhi.value=10,this.pdMaterial.uniforms.depthPhi.value=2,this.pdMaterial.uniforms.normalPhi.value=3,this.pdMaterial.uniforms.radius.value=8,this.depthRenderMaterial=new X({defines:Object.assign({},ge.defines),uniforms:Z.clone(ge.uniforms),vertexShader:ge.vertexShader,fragmentShader:ge.fragmentShader,blending:B}),this.depthRenderMaterial.uniforms.cameraNear.value=this.camera.near,this.depthRenderMaterial.uniforms.cameraFar.value=this.camera.far,this.copyMaterial=new X({uniforms:Z.clone(Me.uniforms),vertexShader:Me.vertexShader,fragmentShader:Me.fragmentShader,transparent:!0,depthTest:!1,depthWrite:!1,blendSrc:Je,blendDst:me,blendEquation:ue,blendSrcAlpha:$e,blendDstAlpha:me,blendEquationAlpha:ue}),this.blendMaterial=new X({uniforms:Z.clone(He.uniforms),vertexShader:He.vertexShader,fragmentShader:He.fragmentShader,transparent:!0,depthTest:!1,depthWrite:!1,blending:Mt,blendSrc:Je,blendDst:me,blendEquation:ue,blendSrcAlpha:$e,blendDstAlpha:me,blendEquationAlpha:ue}),this._fsQuad=new Ze(null),this._originalClearColor=new Xe,this.setGBuffer(o?o.depthTexture:void 0,o?o.normalTexture:void 0),a!==void 0&&this.updateGtaoMaterial(a),n!==void 0&&this.updatePdMaterial(n)}setSize(e,t){this.width=e,this.height=t,this.gtaoRenderTarget.setSize(e,t),this.normalRenderTarget.setSize(e,t),this.pdRenderTarget.setSize(e,t),this.gtaoMaterial.uniforms.resolution.value.set(e,t),this.gtaoMaterial.uniforms.cameraProjectionMatrix.value.copy(this.camera.projectionMatrix),this.gtaoMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse),this.pdMaterial.uniforms.resolution.value.set(e,t),this.pdMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse)}dispose(){this.gtaoNoiseTexture.dispose(),this.pdNoiseTexture.dispose(),this.normalRenderTarget.dispose(),this.gtaoRenderTarget.dispose(),this.pdRenderTarget.dispose(),this.normalMaterial.dispose(),this.pdMaterial.dispose(),this.copyMaterial.dispose(),this.depthRenderMaterial.dispose(),this._fsQuad.dispose()}get gtaoMap(){return this.pdRenderTarget.texture}setGBuffer(e,t){e!==void 0?(this.depthTexture=e,this.normalTexture=t,this._renderGBuffer=!1):(this.depthTexture=new yt,this.depthTexture.format=bt,this.depthTexture.type=St,this.normalRenderTarget=new qe(this.width,this.height,{minFilter:et,magFilter:et,type:Ye,depthTexture:this.depthTexture}),this.normalTexture=this.normalRenderTarget.texture,this._renderGBuffer=!0);const i=this.normalTexture?1:0,s=this.depthTexture===this.normalTexture?"w":"x";this.gtaoMaterial.defines.NORMAL_VECTOR_TYPE=i,this.gtaoMaterial.defines.DEPTH_SWIZZLING=s,this.gtaoMaterial.uniforms.tNormal.value=this.normalTexture,this.gtaoMaterial.uniforms.tDepth.value=this.depthTexture,this.pdMaterial.defines.NORMAL_VECTOR_TYPE=i,this.pdMaterial.defines.DEPTH_SWIZZLING=s,this.pdMaterial.uniforms.tNormal.value=this.normalTexture,this.pdMaterial.uniforms.tDepth.value=this.depthTexture,this.depthRenderMaterial.uniforms.tDepth.value=this.normalRenderTarget.depthTexture}setSceneClipBox(e){e?(this.gtaoMaterial.needsUpdate=this.gtaoMaterial.defines.SCENE_CLIP_BOX!==1,this.gtaoMaterial.defines.SCENE_CLIP_BOX=1,this.gtaoMaterial.uniforms.sceneBoxMin.value.copy(e.min),this.gtaoMaterial.uniforms.sceneBoxMax.value.copy(e.max)):(this.gtaoMaterial.needsUpdate=this.gtaoMaterial.defines.SCENE_CLIP_BOX===0,this.gtaoMaterial.defines.SCENE_CLIP_BOX=0)}updateGtaoMaterial(e){e.radius!==void 0&&(this.gtaoMaterial.uniforms.radius.value=e.radius),e.distanceExponent!==void 0&&(this.gtaoMaterial.uniforms.distanceExponent.value=e.distanceExponent),e.thickness!==void 0&&(this.gtaoMaterial.uniforms.thickness.value=e.thickness),e.distanceFallOff!==void 0&&(this.gtaoMaterial.uniforms.distanceFallOff.value=e.distanceFallOff,this.gtaoMaterial.needsUpdate=!0),e.scale!==void 0&&(this.gtaoMaterial.uniforms.scale.value=e.scale),e.samples!==void 0&&e.samples!==this.gtaoMaterial.defines.SAMPLES&&(this.gtaoMaterial.defines.SAMPLES=e.samples,this.gtaoMaterial.needsUpdate=!0),e.screenSpaceRadius!==void 0&&(e.screenSpaceRadius?1:0)!==this.gtaoMaterial.defines.SCREEN_SPACE_RADIUS&&(this.gtaoMaterial.defines.SCREEN_SPACE_RADIUS=e.screenSpaceRadius?1:0,this.gtaoMaterial.needsUpdate=!0)}updatePdMaterial(e){let t=!1;e.lumaPhi!==void 0&&(this.pdMaterial.uniforms.lumaPhi.value=e.lumaPhi),e.depthPhi!==void 0&&(this.pdMaterial.uniforms.depthPhi.value=e.depthPhi),e.normalPhi!==void 0&&(this.pdMaterial.uniforms.normalPhi.value=e.normalPhi),e.radius!==void 0&&e.radius!==this.radius&&(this.pdMaterial.uniforms.radius.value=e.radius),e.radiusExponent!==void 0&&e.radiusExponent!==this.pdRadiusExponent&&(this.pdRadiusExponent=e.radiusExponent,t=!0),e.rings!==void 0&&e.rings!==this.pdRings&&(this.pdRings=e.rings,t=!0),e.samples!==void 0&&e.samples!==this.pdSamples&&(this.pdSamples=e.samples,t=!0),t&&(this.pdMaterial.defines.SAMPLES=this.pdSamples,this.pdMaterial.defines.SAMPLE_VECTORS=ht(this.pdSamples,this.pdRings,this.pdRadiusExponent),this.pdMaterial.needsUpdate=!0)}render(e,t,i){switch(this._renderGBuffer&&(this._overrideVisibility(),this._renderOverride(e,this.normalMaterial,this.normalRenderTarget,7829503,1),this._restoreVisibility()),this.gtaoMaterial.uniforms.cameraNear.value=this.camera.near,this.gtaoMaterial.uniforms.cameraFar.value=this.camera.far,this.gtaoMaterial.uniforms.cameraProjectionMatrix.value.copy(this.camera.projectionMatrix),this.gtaoMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse),this.gtaoMaterial.uniforms.cameraWorldMatrix.value.copy(this.camera.matrixWorld),this._renderPass(e,this.gtaoMaterial,this.gtaoRenderTarget,16777215,1),this.pdMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse),this._renderPass(e,this.pdMaterial,this.pdRenderTarget,16777215,1),this.output){case V.OUTPUT.Off:break;case V.OUTPUT.Diffuse:this.copyMaterial.uniforms.tDiffuse.value=i.texture,this.copyMaterial.blending=B,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t);break;case V.OUTPUT.AO:this.copyMaterial.uniforms.tDiffuse.value=this.gtaoRenderTarget.texture,this.copyMaterial.blending=B,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t);break;case V.OUTPUT.Denoise:this.copyMaterial.uniforms.tDiffuse.value=this.pdRenderTarget.texture,this.copyMaterial.blending=B,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t);break;case V.OUTPUT.Depth:this.depthRenderMaterial.uniforms.cameraNear.value=this.camera.near,this.depthRenderMaterial.uniforms.cameraFar.value=this.camera.far,this._renderPass(e,this.depthRenderMaterial,this.renderToScreen?null:t);break;case V.OUTPUT.Normal:this.copyMaterial.uniforms.tDiffuse.value=this.normalRenderTarget.texture,this.copyMaterial.blending=B,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t);break;case V.OUTPUT.Default:this.copyMaterial.uniforms.tDiffuse.value=i.texture,this.copyMaterial.blending=B,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t),this.blendMaterial.uniforms.intensity.value=this.blendIntensity,this.blendMaterial.uniforms.tDiffuse.value=this.pdRenderTarget.texture,this._renderPass(e,this.blendMaterial,this.renderToScreen?null:t);break;default:console.warn("THREE.GTAOPass: Unknown output type.")}}_renderPass(e,t,i,s,o){e.getClearColor(this._originalClearColor);const a=e.getClearAlpha(),n=e.autoClear;e.setRenderTarget(i),e.autoClear=!1,s!=null&&(e.setClearColor(s),e.setClearAlpha(o||0),e.clear()),this._fsQuad.material=t,this._fsQuad.render(e),e.autoClear=n,e.setClearColor(this._originalClearColor),e.setClearAlpha(a)}_renderOverride(e,t,i,s,o){e.getClearColor(this._originalClearColor);const a=e.getClearAlpha(),n=e.autoClear;e.setRenderTarget(i),e.autoClear=!1,s=t.clearColor||s,o=t.clearAlpha||o,s!=null&&(e.setClearColor(s),e.setClearAlpha(o||0),e.clear()),this.scene.overrideMaterial=t,e.render(this.scene,this.camera),this.scene.overrideMaterial=null,e.autoClear=n,e.setClearColor(this._originalClearColor),e.setClearAlpha(a)}_overrideVisibility(){const e=this.scene,t=this._visibilityCache;e.traverse(function(i){(i.isPoints||i.isLine||i.isLine2)&&i.visible&&(i.visible=!1,t.push(i))})}_restoreVisibility(){const e=this._visibilityCache;for(let t=0;t<e.length;t++)e[t].visible=!0;e.length=0}_generateNoise(e=64){const t=new ei,i=e*e*4,s=new Uint8Array(i);for(let a=0;a<e;a++)for(let n=0;n<e;n++){const r=a,l=n;s[(a*e+n)*4]=(t.noise(r,l)*.5+.5)*255,s[(a*e+n)*4+1]=(t.noise(r+e,l)*.5+.5)*255,s[(a*e+n)*4+2]=(t.noise(r,l+e)*.5+.5)*255,s[(a*e+n)*4+3]=(t.noise(r+e,l+e)*.5+.5)*255}const o=new nt(s,e,e,Pt,Tt);return o.wrapS=be,o.wrapT=be,o.needsUpdate=!0,o}}V.OUTPUT={Off:-1,Default:0,Diffuse:1,Depth:2,Normal:3,AO:4,Denoise:5};const xe={name:"OutputShader",uniforms:{tDiffuse:{value:null},toneMappingExposure:{value:1}},vertexShader:`
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

		}`};class ti extends J{constructor(){super(),this.isOutputPass=!0,this.uniforms=Z.clone(xe.uniforms),this.material=new Ct({name:xe.name,uniforms:this.uniforms,vertexShader:xe.vertexShader,fragmentShader:xe.fragmentShader}),this._fsQuad=new Ze(this.material),this._outputColorSpace=null,this._toneMapping=null}render(e,t,i){this.uniforms.tDiffuse.value=i.texture,this.uniforms.toneMappingExposure.value=e.toneMappingExposure,(this._outputColorSpace!==e.outputColorSpace||this._toneMapping!==e.toneMapping)&&(this._outputColorSpace=e.outputColorSpace,this._toneMapping=e.toneMapping,this.material.defines={},Et.getTransfer(this._outputColorSpace)===Rt&&(this.material.defines.SRGB_TRANSFER=""),this._toneMapping===Dt?this.material.defines.LINEAR_TONE_MAPPING="":this._toneMapping===At?this.material.defines.REINHARD_TONE_MAPPING="":this._toneMapping===Nt?this.material.defines.CINEON_TONE_MAPPING="":this._toneMapping===rt?this.material.defines.ACES_FILMIC_TONE_MAPPING="":this._toneMapping===kt?this.material.defines.AGX_TONE_MAPPING="":this._toneMapping===zt?this.material.defines.NEUTRAL_TONE_MAPPING="":this._toneMapping===Ut&&(this.material.defines.CUSTOM_TONE_MAPPING=""),this.material.needsUpdate=!0),this.renderToScreen===!0?(e.setRenderTarget(null),this._fsQuad.render(e)):(e.setRenderTarget(t),this.clear&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),this._fsQuad.render(e))}dispose(){this.material.dispose(),this._fsQuad.dispose()}}const G=class G{constructor(e,{clearColor:t=1053466,shadows:i=!0}={}){this.canvas=e,this.renderer=new Ft({canvas:e,antialias:!0}),this.renderer.setPixelRatio(Math.min(window.devicePixelRatio,2)),this.renderer.setClearColor(t),this.renderer.shadowMap.enabled=i,this.renderer.shadowMap.type=It,this.renderer.toneMapping=rt,this.renderer.toneMappingExposure=1.15,this.input=new Gt(e),this.world=null,this.time=0,this.running=!1,this.aoEnabled=typeof location<"u"&&new URLSearchParams(location.search).get("ao")==="1",this._composer=null,this._accum=0,this._last=0,this._frame=this._frame.bind(this),this._onResize=this._onResize.bind(this),window.addEventListener("resize",this._onResize),this._onResize()}start(){this.running||(this.running=!0,this._last=performance.now(),requestAnimationFrame(this._frame))}stop(){this.running=!1}_frame(e){if(!this.running)return;requestAnimationFrame(this._frame);let t=(e-this._last)/1e3;this._last=e,t=Math.min(t,.25),this.time+=t;const i=this.world;if(i){this._accum+=t;let s=0;for(;this._accum>=G.FIXED_DT&&s<G.MAX_CATCHUP;)i._fixedUpdate(G.FIXED_DT,this),this._accum-=G.FIXED_DT,s++;s===G.MAX_CATCHUP&&(this._accum=0),jt.update(t),i._update(t,this),i.camera&&(this.aoEnabled&&!this._composer&&this._buildComposer(i),this._composer?((this._rp.camera!==i.camera||this._rp.scene!==i.scene)&&(this._rp.camera=i.camera,this._rp.scene=i.scene,this._gtao.camera=i.camera,this._gtao.scene=i.scene),this._composer.render()):this.renderer.render(i.scene,i.camera))}this.input.endFrame()}_buildComposer(e){const t=this.canvas.clientWidth||window.innerWidth,i=this.canvas.clientHeight||window.innerHeight;this._composer=new Zt(this.renderer),this._rp=new Qt(e.scene,e.camera),this._gtao=new V(e.scene,e.camera,t,i),this._gtao.output=V.OUTPUT.Default,this._composer.addPass(this._rp),this._composer.addPass(this._gtao),this._composer.addPass(new ti),typeof window<"u"&&(window.__pfAO=this._gtao)}_onResize(){var i,s;const e=this.canvas.clientWidth||window.innerWidth,t=this.canvas.clientHeight||window.innerHeight;this.renderer.setSize(e,t,!1),(i=this._composer)==null||i.setSize(e,t),this.aspect=e/t,(s=this.world)!=null&&s.camera&&(this.world.camera.aspect=this.aspect,this.world.camera.updateProjectionMatrix())}dispose(){this.stop(),window.removeEventListener("resize",this._onResize),this.input.dispose(),this.renderer.dispose()}};Be(G,"FIXED_DT",1/60),Be(G,"MAX_CATCHUP",5);let st=G;class li{constructor(){this.scene=new Lt,this.camera=new Vt(70,16/9,.1,2e3),this.entities=[],this._pendingRemove=new Set}spawn(e="entity"){var i;const t=new ii(e,this);this.entities.push(t),this.scene.add(t.object3d);for(const s of t.components)(i=s.init)==null||i.call(s,t,this);return t}destroy(e){this._pendingRemove.add(e)}find(e){return this.entities.find(t=>t.name===e)??null}findAll(e){return this.entities.filter(t=>t.name===e)}_fixedUpdate(e,t){var i;for(const s of this.entities)if(!this._pendingRemove.has(s))for(const o of s.components)(i=o.fixedUpdate)==null||i.call(o,e,{engine:t,world:this,input:t.input,entity:s});this._flush()}_update(e,t){var i;for(const s of this.entities)if(!this._pendingRemove.has(s))for(const o of s.components)(i=o.update)==null||i.call(o,e,{engine:t,world:this,input:t.input,entity:s});this._flush()}_flush(){var e;if(this._pendingRemove.size){for(const t of this._pendingRemove){const i=this.entities.indexOf(t);i>=0&&this.entities.splice(i,1),this.scene.remove(t.object3d);for(const s of t.components)(e=s.dispose)==null||e.call(s)}this._pendingRemove.clear()}}}class ii{constructor(e,t){this.name=e,this.world=t,this.object3d=new lt,this.object3d.name=e,this.components=[]}at(e,t,i){return this.object3d.position.set(e,t,i),this}get position(){return this.object3d.position}get rotation(){return this.object3d.rotation}add(e){var t;return this.components.push(e),e.entity=this,this.world&&((t=e.init)==null||t.call(e,this,this.world)),this}mesh(e){return this.object3d.add(e),this}get(e){return this.components.find(t=>t instanceof e)??null}}class Se{constructor({size:e=[1,1,1],offset:t=[0,0,0],trigger:i=!1,onEnter:s=null,onExit:o=null}={}){this.size=new R(...e),this.offset=new R(...t),this.trigger=i,this.onEnter=s,this.onExit=o,this._inside=new Set}aabb(e=new Q){const t=this.entity.position.clone().add(this.offset);return e.min.copy(t).addScaledVector(this.size,-.5),e.max.copy(t).addScaledVector(this.size,.5),e}}class hi{constructor({size:e=[1,1,1],offset:t=[0,0,0],gravity:i=24,maxFall:s=55,bounce:o=0}={}){this.size=new R(...e),this.offset=new R(...t),this.gravity=i,this.maxFall=s,this.bounce=o,this.velocity=new R,this.onGround=!1,this._box=new Q,this._other=new Q}fixedUpdate(e,{world:t,entity:i}){this.velocity.y=Math.max(this.velocity.y-this.gravity*e,-this.maxFall);const s=si(t,i);this.onGround=!1;for(const o of[0,2,1]){const a=this.velocity.getComponent(o)*e;a!==0&&(i.position.setComponent(o,i.position.getComponent(o)+a),this._resolve(o,i,s))}for(const o of t.entities)for(const a of o.components){if(typeof a.heightAt!="function"||typeof a.slopeAt!="function")continue;const n=i.position.y+this.offset.y-this.size.y*.5,r=a.heightAt(i.position.x,i.position.z);r!==-1/0&&n<=r+.02&&(i.position.y=r+this.size.y*.5-this.offset.y+.001,this.velocity.y<0&&(this.velocity.y=0),this.onGround=!0)}this._fireTriggers(t,i)}_bodyBox(e){const t=e.position.clone().add(this.offset);return this._box.min.copy(t).addScaledVector(this.size,-.5),this._box.max.copy(t).addScaledVector(this.size,.5),this._box}_resolve(e,t,i){const s=this._bodyBox(t);for(const o of i){if(o.trigger)continue;const a=o.aabb(this._other);if(!s.intersectsBox(a))continue;if(e!==1){const f=a.max.y-s.min.y;if(f>0&&f<=.4){t.position.y+=f+.001,this._bodyBox(t);continue}}const n=this.velocity.getComponent(e),r=this.size.getComponent(e)*.5,l=this.offset.getComponent(e);let d;n>0?d=a.min.getComponent(e)-r-l-1e-4:d=a.max.getComponent(e)+r-l+1e-4,t.position.setComponent(e,d),e===1&&n<0&&(this.onGround=!0),this.velocity.setComponent(e,this.bounce?-n*this.bounce:0),this._bodyBox(t)}}_fireTriggers(e,t){var s,o;const i=this._bodyBox(t);for(const a of e.entities)for(const n of a.components){if(!(n instanceof Se)||!n.trigger||a===t)continue;const r=i.intersectsBox(n.aabb(n._tmp??(n._tmp=new Q))),l=n._inside.has(t);r&&!l?(n._inside.add(t),(s=n.onEnter)==null||s.call(n,t,a)):!r&&l&&(n._inside.delete(t),(o=n.onExit)==null||o.call(n,t,a))}}}function si(m,e){const t=[];for(const i of m.entities)if(i!==e)for(const s of i.components)s instanceof Se&&(s.entity=i,t.push(s));return t}function ci(m,e,t,i=100){const s=new Ot(e,t.clone().normalize()),o=new Q,a=new R;let n=null;for(const r of m.entities)for(const l of r.components){if(!(l instanceof Se)||(l.entity=r,!s.intersectBox(l.aabb(o),a)))continue;const d=e.distanceTo(a);d<=i&&(!n||d<n.distance)&&(n={entity:r,collider:l,point:a.clone(),distance:d})}return n}class oi{constructor({mass:e=1200,enginePower:t=10,brakePower:i=15,topSpeed:s=38,reverseSpeed:o=9,wheelbase:a=2.9,steerMax:n=.62,steerSpeed:r=1.9,maxLatAccel:l=8,slipPeak:d=.14,slideFriction:f=.72,drag:_=.0045,rolling:c=.35,gravity:h=24,chassis:M=null,wheels:T=null,wheelRadius:S=.32,suspension:E=null,suspFreq:C=2.3,suspDamp:x=.55,rollGain:P=.0065,pitchGain:D=.0075,swayBar:b=.5,maxTravel:y=.055,maxRoll:u=.055,maxPitch:p=.07}={}){Object.assign(this,{mass:e,enginePower:t,brakePower:i,topSpeed:s,reverseSpeed:o,wheelbase:a,steerMax:n,steerSpeed:r,maxLatAccel:l,slipPeak:d,slideFriction:f,drag:_,rolling:c,gravity:h,chassis:M,wheels:T,wheelRadius:S,suspension:E,suspFreq:C,suspDamp:x,rollGain:P,pitchGain:D,swayBar:b,maxTravel:y,maxRoll:u,maxPitch:p}),this.inertia=e*1.9,this.throttle=0,this.steerInput=0,this.handbrake=!1,this.velocity=new R,this.steer=0,this.speed=0,this.yawRate=0,this.slipFront=0,this.slipRear=0,this.wheelspin=!1,this.sliding=!1,this.onGround=!0,this._lean={roll:0,pitch:0},this._wheelSpin=0,this._prevSpeed=0,this._susp={heave:0,heaveV:0,roll:0,rollV:0,pitch:0,pitchV:0},this.upset=!1,this._quat=new tt,this._angVel=new R,this._half=new R(.95,.62,2.2),this._box=new Q,this._other=new Q}applyImpulse(e,t,i){this.velocity.addScaledVector(e,1/this.mass);const s=i.position.clone();s.y+=this._half.y;const a=t.clone().sub(s).clone().cross(e).multiplyScalar(1/this.inertia);if(this.upset){this._angVel.add(a);return}a.length()>.9||e.y/this.mass>3.5||Math.abs(a.x)+Math.abs(a.z)>.6?this._enterUpset(i,a):this.yawRate+=a.y}_enterUpset(e,t=null){this.upset=!0,this._quat.setFromEuler(new Ge(this._susp.pitch,e.rotation.y,this._susp.roll,"YXZ")),this._angVel.set(0,this.yawRate,0),t&&this._angVel.add(t),this.sliding=!0}_settle(e){this.upset=!1;const t=new Ge().setFromQuaternion(this._quat,"YXZ");e.rotation.set(0,t.y,0),this.yawRate=this._angVel.y;const i=new R(Math.sin(t.y),0,Math.cos(t.y));this.speed=this.velocity.dot(i),this.sliding=!1,this._susp={heave:0,heaveV:0,roll:0,rollV:0,pitch:0,pitchV:0}}recover(e,t){const s=(this.upset?new Ge().setFromQuaternion(this._quat,"YXZ"):e.rotation).y;this.upset=!1,this.velocity.set(0,0,0),this.yawRate=0,this.speed=0,this._angVel.set(0,0,0),this.sliding=!1,this.wheelspin=!1,this._susp={heave:0,heaveV:0,roll:0,rollV:0,pitch:0,pitchV:0},e.rotation.set(0,s,0),e.position.y=We(t,e.position.x,e.position.z)}get kmh(){return Math.abs(this.speed*3.6)}_tire(e){const t=e/this.slipPeak,i=Math.abs(t);if(i<=1)return Math.sign(t)*Math.sin(Math.PI/2*i);const s=1-Math.min((i-1)*.35,1-this.slideFriction);return Math.sign(t)*s}fixedUpdate(e,{world:t,entity:i}){if(this.upset){this._tumble(e,t,i);return}const s=i.rotation.y,o=new R(Math.sin(s),0,Math.cos(s)),a=new R(o.z,0,-o.x);let n=this.velocity.dot(o),r=this.velocity.dot(a);const l=1/(1+Math.abs(n)*.038),d=this.steerInput*this.steerMax*l,f=F.clamp(d-this.steer,-this.steerSpeed*e,this.steerSpeed*e);this.steer+=f;const _=F.clamp(this.throttle,-1,1);let c=0;_>.01?n>=-.5?c=_*this.enginePower*Math.max(0,1-n/this.topSpeed):c=this.brakePower:_<-.01&&(n>.5?c=_*this.brakePower:c=_*this.enginePower*.55*Math.max(0,1-Math.abs(n)/this.reverseSpeed));const h=Math.abs(n),M=this.wheelbase/2,T=this.wheelbase/2,S=this.maxLatAccel;if(h>2.5){const u=Math.sign(n||1);this.slipFront=Math.atan2(r+M*this.yawRate,h)-this.steer*u,this.slipRear=Math.atan2(r-T*this.yawRate,h);const p=F.clamp(Math.abs(c)/S,0,1);let v=Math.sqrt(Math.max(.06,1-p*p));this.wheelspin=_>.5&&Math.abs(c)>S*.95,this.wheelspin&&(c*=.55,v=.35),this.handbrake&&(v=.3,c-=Math.sign(n)*this.brakePower*.55);const w=S*.5,g=-this._tire(this.slipFront)*w,U=-this._tire(this.slipRear)*w*v;this.sliding=Math.abs(this.slipRear)>this.slipPeak*1.05||this.wheelspin;const z=(Math.abs(this.slipFront)+Math.abs(this.slipRear))*S*.22,A=Math.sign(n)*(this.drag*n*n+this.rolling+z);n+=(c-A+r*this.yawRate)*e,r+=(g+U-n*this.yawRate)*e;const k=(M*g-T*U)*this.mass/this.inertia;if(this.yawRate=F.clamp(this.yawRate+k*e,-3.5,3.5),i.rotation.y=s+this.yawRate*e,Math.abs(r)>18&&Math.hypot(n,r)>22&&this.onGround){const L=new R(Math.sin(s),0,Math.cos(s)).multiplyScalar(Math.sign(r)*(2.6+Math.abs(r)*.06));this._enterUpset(i,L),this.velocity.y=Math.max(this.velocity.y,3.5);return}}else{this.slipFront=this.slipRear=0,this.wheelspin=_>.9&&this.enginePower*.55>S*.6,this.sliding=this.wheelspin,this.wheelspin&&(c*=.55);const u=Math.sign(n)*(this.drag*n*n+this.rolling*Math.min(1,h));this.handbrake&&(c-=Math.sign(n)*this.brakePower*.55),n+=(c-u)*e,Math.abs(n)<.08&&Math.abs(_)<.01&&(n=0),r*=Math.exp(-8*e);const p=n/this.wheelbase*Math.tan(this.steer);this.yawRate+=(p-this.yawRate)*(1-Math.exp(-e*10)),i.rotation.y=s+this.yawRate*e}const E=this.velocity.y-this.gravity*e,C=i.rotation.y,x=new R(Math.sin(C),0,Math.cos(C)),P=new R(x.z,0,-x.x);this.velocity.copy(x.multiplyScalar(n)).addScaledVector(P,r),this.velocity.y=E,this.speed=n,i.position.addScaledVector(this.velocity,e);const D=!this.onGround;this.onGround=!1;let b=-1/0;for(const u of t.entities)for(const p of u.components)if(typeof p.heightAt=="function"&&typeof p.slopeAt=="function"){const v=p.heightAt(i.position.x,i.position.z);v>b&&(b=v)}if(b===-1/0&&(b=0),i.position.y<=b+.02){if(i.position.y=b,D&&this.velocity.y<-6){const p=i.rotation.y,v=this.velocity.x*Math.cos(p)-this.velocity.z*Math.sin(p);if(Math.abs(v)>8){const w=-this.velocity.y,g=new R(Math.sin(p),0,Math.cos(p)).multiplyScalar(Math.sign(v)*(1.8+Math.abs(v)*.09+w*.05));this._enterUpset(i,g),this.velocity.y=2.5;return}}const u=F.clamp((b-(this._prevGroundY??b))/Math.max(e,1e-4),0,16);this.velocity.y=Math.max(this.velocity.y,u),this.velocity.y<0&&(this.velocity.y=0),this.onGround=!0}this._prevGroundY=b,this._collide(t,i);const y=(n-this._prevSpeed)/Math.max(e,1e-4);if(this._prevSpeed=n,this.suspension)this._suspend(e,t,i,n,c,y);else if(this.chassis){const u=this.yawRate*n,p=F.clamp(-u*.011-r*.02,-.15,.15),v=F.clamp(-c*.011,-.09,.12),w=1-Math.exp(-e*7);this._lean.roll+=(p-this._lean.roll)*w,this._lean.pitch+=(v-this._lean.pitch)*w,this.chassis.rotation.z=this._lean.roll,this.chassis.rotation.x=this._lean.pitch}if(this.wheels){const u=this.wheelspin?this.topSpeed*1.4:n;this._wheelSpin+=u/this.wheelRadius*e;for(const p of["fl","fr","rl","rr"]){const v=this.wheels[p];v&&(v.rotation.x=this._wheelSpin,p[0]==="f"&&(v.rotation.y=this.steer*.9))}}}_tumble(e,t,i){const s=this.gravity;this.velocity.y-=s*e,i.position.addScaledVector(this.velocity,e);const o=this._angVel,a=new tt(o.x*e*.5,o.y*e*.5,o.z*e*.5,1).normalize();this._quat.premultiply(a).normalize();const n=i.position.clone();n.y+=this._half.y;const r=new R,l=new R;let d=0,f=0;const _=new R,c=new R,h=new R;for(let S=0;S<8;S++){_.set((S&1?1:-1)*this._half.x,(S&2?1:-1)*this._half.y,(S&4?1:-1)*this._half.z).applyQuaternion(this._quat),c.copy(_),_.add(n);const C=We(t,_.x,_.z)-_.y;if(C<=0)continue;d++,f=Math.max(f,C),h.copy(this._angVel).cross(c).add(this.velocity);let x=C*240-h.y*9;if(x<0)continue;x=Math.min(x,150),r.y+=x;const P=Math.hypot(h.x,h.z);P>.1&&(r.x-=h.x/P*x*.55,r.z-=h.z/P*x*.55),l.add(c.clone().cross(new R(-(h.x/Math.max(P,.1))*x*.55,x,-(h.z/Math.max(P,.1))*x*.55)))}this.velocity.addScaledVector(r,e),this._angVel.addScaledVector(l,e*this.mass/this.inertia*.08),this._angVel.multiplyScalar(Math.exp(-e*(d?1.6:.25))),this.velocity.x*=Math.exp(-e*(d?.9:.05)),this.velocity.z*=Math.exp(-e*(d?.9:.05)),f>.02&&this.velocity.y<0&&(this.velocity.y*=-.35),f>.3&&(i.position.y+=f-.3);const M=new R(0,1,0).applyQuaternion(this._quat);if(this._angVel.length()<.7&&this.velocity.length()<3&&d>0&&M.y>.85){this._settle(i);return}i.object3d.quaternion.copy(this._quat)}_suspend(e,t,i,s,o,a){const n=this.suspension,r=i.position.y,l=i.rotation.y,d=Math.sin(l),f=Math.cos(l),_=Math.cos(l),c=-Math.sin(l),h={};for(const A of["fl","fr","rl","rr"]){const k=n.corners[A];if(!k)continue;const L=i.position.x+_*k.ox+d*k.oz,N=i.position.z+c*k.ox+f*k.oz,I=We(t,L,N);h[A]=I,n.wheels[A].position.y=(I+n.wheelRadius-r)/n.scale}const M=this.yawRate*s,T=(h.fl+h.rl)*.5,S=(h.fr+h.rr)*.5,E=(h.fl+h.fr)*.5,C=(h.rl+h.rr)*.5,x=Math.atan2(T-S,n.track),P=Math.atan2(E-C,n.wheelbase),D=F.clamp(-M*this.rollGain*(1-this.swayBar*.6),-this.maxRoll,this.maxRoll)+x,b=F.clamp(-a*this.pitchGain,-this.maxPitch,this.maxPitch)+P,y=(T+S)*.5-r,u=2*Math.PI*this.suspFreq,p=this.suspDamp,v=u*(1+this.swayBar*.6),w=Math.min(1,p*(1+this.swayBar*.5)),g=this._susp,U=(A,k,L,N=u,I=p)=>{const O=-N*N*(A-L)-2*I*N*k;return k+=O*e,A+=k*e,[A,k]};[g.heave,g.heaveV]=U(g.heave,g.heaveV,y),[g.roll,g.rollV]=U(g.roll,g.rollV,D,v,w),[g.pitch,g.pitchV]=U(g.pitch,g.pitchV,b),g.heave=F.clamp(g.heave,y-this.maxTravel,y+this.maxTravel),g.roll=F.clamp(g.roll,x-this.maxRoll,x+this.maxRoll),g.pitch=F.clamp(g.pitch,P-this.maxPitch,P+this.maxPitch);const z=n.bodyRoot;z.position.y=n.baseBodyY+g.heave,z.rotation.z=g.roll,z.rotation.x=g.pitch}_collide(e,t){const i=t.position;this._box.min.set(i.x-1.1,i.y,i.z-1.6),this._box.max.set(i.x+1.1,i.y+1.4,i.z+1.6);for(const s of e.entities)for(const o of s.components){if(!(o instanceof Se)||o.trigger||s===t)continue;o.entity=s;const a=o.aabb(this._other);if(!this._box.intersectsBox(a))continue;const n=a.max.x-this._box.min.x,r=this._box.max.x-a.min.x,l=a.max.z-this._box.min.z,d=this._box.max.z-a.min.z,f=a.max.y-this._box.min.y,_=Math.min(n,r),c=Math.min(l,d),h=f;h<.5?(h>.001&&(t.position.y+=h),this.velocity.y<0&&(this.velocity.y=0),this.onGround=!0):_<c?(t.position.x+=n<r?_:-_,this.velocity.x*=-.25,this.velocity.multiplyScalar(.82)):(t.position.z+=l<d?c:-c,this.velocity.z*=-.25,this.velocity.multiplyScalar(.82))}}}function We(m,e,t){let i=-1/0;for(const s of m.entities)for(const o of s.components)if(typeof o.heightAt=="function"&&typeof o.slopeAt=="function"){const a=o.heightAt(e,t);a!==-1/0&&a>i&&(i=a)}return i===-1/0?0:i}class di{constructor({enabled:e=()=>!0}={}){this.enabled=e}fixedUpdate(e,{input:t,entity:i}){const s=i.get(oi);if(!s)return;if(!this.enabled()){s.throttle=0,s.steerInput=0,s.handbrake=!1;return}const o=t.stick("left");s.throttle=(t.down("KeyW")||t.down("ArrowUp")?1:0)-(t.down("KeyS")||t.down("ArrowDown")?1:0)-o.y,s.steerInput=(t.down("KeyA")||t.down("ArrowLeft")?1:0)-(t.down("KeyD")||t.down("ArrowRight")?1:0)-o.x,s.handbrake=t.down("Space")}}class fi{constructor({heightAt:e,colorAt:t=(r,l,d,f,_)=>_.setHSL(.3,.4,.35),decorate:i=null,tileSize:s=128,rings:o=[[1,48],[2,24],[4,12]],skirt:a=12,anchor:n=null}){this._fn=e,this._colorAt=t,this._decorate=i,this.tileSize=s,this.rings=o,this.skirt=a,this.anchorFn=n,this.maxRing=o[o.length-1][0],this._tiles=new Map,this._queue=[],this.tileCount=0}heightAt(e,t){return this._fn(e,t)}slopeAt(e,t,i=1.5){const s=this._fn(e,t);return Math.max(Math.abs(this._fn(e+i,t)-s),Math.abs(this._fn(e,t+i)-s))/i}update(e,{world:t,engine:i,entity:s}){var l;this._entity=s;const o=this.anchorFn?this.anchorFn():t.camera.position,a=Math.floor(o.x/this.tileSize),n=Math.floor(o.z/this.tileSize),r=new Map;for(let d=-this.maxRing;d<=this.maxRing;d++)for(let f=-this.maxRing;f<=this.maxRing;f++){const _=Math.max(Math.abs(f),Math.abs(d)),c=(l=this.rings.find(([h])=>_<=h))==null?void 0:l[1];c!==void 0&&r.set(a+f+","+(n+d),c)}for(const[d,f]of this._tiles)!r.has(d)&&!f.building&&this._dispose(t,d);this._queue.length=0;for(const[d,f]of r){const _=this._tiles.get(d);if(!_||_.res!==f&&!_.building){const[c,h]=d.split(",").map(Number),M=Math.max(Math.abs(c-a),Math.abs(h-n));this._queue.push({key:d,ix:c,iz:h,res:f,d:M})}}if(this._queue.sort((d,f)=>d.d-f.d),this._queue.length){const d=this._queue.shift();this._build(t,s,d)}this.tileCount=this._tiles.size}_build(e,t,{key:i,ix:s,iz:o,res:a}){const n=this._tiles.get(i),r=this.tileSize,l=s*r,d=o*r,f=new lt,_=a+1,c=_+2,h=new Float32Array(c*c*3),M=new Float32Array(c*c*3),T=new Xe,S=r/a;for(let y=0;y<c;y++)for(let u=0;u<c;u++){const p=Math.min(Math.max(u-1,0),_-1),v=Math.min(Math.max(y-1,0),_-1),w=l+p*S,g=d+v*S,U=u===0||y===0||u===c-1||y===c-1,z=this._fn(w,g),A=(y*c+u)*3;h[A]=w,h[A+1]=U?z-this.skirt:z,h[A+2]=g;const k=this.slopeAt(w,g);this._colorAt(w,g,z,k,T),U&&T.multiplyScalar(.55),M[A]=T.r,M[A+1]=T.g,M[A+2]=T.b}const E=[];for(let y=0;y<c-1;y++)for(let u=0;u<c-1;u++){const p=y*c+u,v=p+1,w=p+c,g=w+1;E.push(p,w,v,v,w,g)}const C=new Float32Array(c*c*3),x=S;for(let y=0;y<c;y++)for(let u=0;u<c;u++){const p=(y*c+u)*3,v=h[p],w=h[p+2],g=(this._fn(v+x,w)-this._fn(v-x,w))/(2*x),U=(this._fn(v,w+x)-this._fn(v,w-x))/(2*x),z=1/Math.hypot(g,1,U);C[p]=-g*z,C[p+1]=z,C[p+2]=-U*z}const P=new at;P.setAttribute("position",new je(h,3)),P.setAttribute("normal",new je(C,3)),P.setAttribute("color",new je(M,3)),P.setIndex(E);const D=new ot(P,ct);D.receiveShadow=!0,f.add(D);const b={key:i,ix:s,iz:o,res:a,group:f,x0:l,z0:d,size:r,colliders:[],cleanup:[],building:!1,addCollider:null};this._decorate&&(b.addCollider=y=>{y.entity=t,y._tileKey=i,b.colliders.push(y)},this._decorate(b,f)),this.onTile&&this.onTile(b,D),n&&this._dispose(e,i,n),t.object3d.add(f);for(const y of b.colliders)t.components.push(y);this._tiles.set(i,b)}_dispose(e,t,i=null){var o;const s=i??this._tiles.get(t);if(s){s.dead=!0;for(const a of s.cleanup??[])a();if((o=s.group.parent)==null||o.remove(s.group),s.group.traverse(a=>{var n,r;a.geometry&&a.geometry.dispose(),a.material&&!a.material._shared&&((r=(n=a.material).dispose)==null||r.call(n))}),s.colliders.length&&this._entity){const a=new Set(s.colliders);this._entity.components=this._entity.components.filter(n=>!a.has(n))}i||this._tiles.delete(t)}}rebuild(e){for(const t of[...this._tiles.keys()])this._dispose(e,t)}}const ct=new Bt({vertexColors:!0,roughness:.95});ct._shared=!0;class ai{constructor({size:e=360}={}){const t=this.canvas=document.createElement("canvas"),i=Math.min(2,typeof window<"u"&&window.devicePixelRatio||1);this.w=e,this.h=e*.72,this.dpr=i,t.width=this.w*i,t.height=this.h*i,Object.assign(t.style,{position:"fixed",left:"50%",top:"50%",transform:"translate(-50%,-50%)",width:this.w+"px",height:this.h+"px",pointerEvents:"none",zIndex:"40",display:"none",opacity:"0.92"}),typeof document<"u"&&document.body.appendChild(t),this.ctx=t.getContext("2d"),this.ctx.scale(i,i),this.visible=!1,this.color="#7dff9e"}show(){this.visible=!0,this.canvas.style.display="block"}hide(){this.visible=!1,this.canvas.style.display="none"}render(e){if(!this.visible)return;const t=this.ctx,i=this.w,s=this.h,o=i/2,a=s/2,n=this.color;t.clearRect(0,0,i,s),t.lineWidth=2,t.strokeStyle=n,t.fillStyle=n,t.font="13px 'Consolas', monospace",t.textBaseline="middle";const r=Math.min(i,s)*.42,l=e.pitch||0,d=e.roll||0,f=r/(Math.PI/3);t.save(),t.beginPath(),t.arc(o,a,r,0,Math.PI*2),t.clip(),t.translate(o,a),t.rotate(-d),t.translate(0,l*f),t.strokeStyle=n,t.fillStyle=n,t.beginPath(),t.moveTo(-r*1.6,0),t.lineTo(r*1.6,0),t.stroke(),t.font="10px 'Consolas', monospace",t.textAlign="center";for(let h=-60;h<=60;h+=10){if(h===0)continue;const M=-h*(Math.PI/180)*f,T=h%20===0?34:18;t.globalAlpha=.75,t.beginPath(),t.moveTo(-T,M),t.lineTo(T,M),t.stroke(),h%20===0&&(t.fillText(Math.abs(h),-T-12,M),t.fillText(Math.abs(h),T+12,M))}t.globalAlpha=1,t.restore(),t.strokeStyle=n,t.globalAlpha=.9,t.beginPath(),t.arc(o,a,r,0,Math.PI*2),t.stroke();for(const h of[-60,-45,-30,-20,-10,0,10,20,30,45,60]){const M=-Math.PI/2+h*Math.PI/180,T=r,S=r-(h%30===0?12:7);t.beginPath(),t.moveTo(o+Math.cos(M)*T,a+Math.sin(M)*T),t.lineTo(o+Math.cos(M)*S,a+Math.sin(M)*S),t.stroke()}t.save(),t.translate(o,a),t.rotate(-d),t.beginPath(),t.moveTo(0,-r),t.lineTo(-6,-r+11),t.lineTo(6,-r+11),t.closePath(),t.fillStyle="#ffd23f",t.fill(),t.restore(),t.strokeStyle="#ffd23f",t.lineWidth=3,t.globalAlpha=1,t.beginPath(),t.moveTo(o-46,a),t.lineTo(o-18,a),t.lineTo(o-10,a+8),t.moveTo(o+46,a),t.lineTo(o+18,a),t.lineTo(o+10,a+8),t.moveTo(o,a-4),t.arc(o,a,3,0,Math.PI*2),t.stroke(),t.lineWidth=2;const _=Math.round((e.speed||0)*3.6),c=Math.round(e.altitude||0);if(this._box(t,6,a,66,`${_}`,"km/h","right"),this._box(t,i-6,a,78,`${c} m`,"ALT","left"),e.heading!=null){let h=Math.round((-e.heading*180/Math.PI%360+360)%360);t.fillStyle=n,t.globalAlpha=.95,t.textAlign="center",t.font="14px 'Consolas', monospace";const M=["N","NE","E","SE","S","SW","W","NW"][Math.round(h/45)%8];t.fillText(`${String(h).padStart(3,"0")}°  ${M}`,o,12)}t.globalAlpha=1}_box(e,t,i,s,o,a,n){const r=this.color,l=30,d=n==="right",f=d?t:t-s;e.globalAlpha=.9,e.strokeStyle=r,e.fillStyle="rgba(0,0,0,0.35)",e.beginPath(),e.rect(f,i-l/2,s,l),e.fill(),e.stroke(),e.fillStyle=r,e.textAlign=d?"left":"right",e.font="16px 'Consolas', monospace",e.fillText(o,d?f+6:f+s-6,i),e.font="9px 'Consolas', monospace",e.globalAlpha=.7,e.textAlign="center",e.fillText(a,f+s/2,i-l/2-7),e.globalAlpha=1}dispose(){this.canvas.remove()}}typeof window<"u"&&(window.FlightHUD=ai);class he{constructor({world:e}={}){this.world=e,this.active=!1,this.carIdx=0,this.side="front",this.yaw=.7,this.pitch=.45,this.dist=9,this._drag=null,this._buildUI(),window.addEventListener("keydown",t=>{t.code==="KeyV"&&!t.repeat&&this.toggle()}),window.addEventListener("mousedown",t=>{this.active&&t.target.tagName==="CANVAS"&&(this._drag=[t.clientX,t.clientY])}),window.addEventListener("mouseup",()=>this._drag=null),window.addEventListener("mousemove",t=>{!this.active||!this._drag||(this.yaw-=(t.clientX-this._drag[0])*.008,this.pitch=F.clamp(this.pitch+(t.clientY-this._drag[1])*.006,.05,1.35),this._drag=[t.clientX,t.clientY])}),window.addEventListener("wheel",t=>{this.active&&(this.dist=F.clamp(this.dist+Math.sign(t.deltaY)*.8,4,25))})}get car(){var t,i;const e=((t=window.__pf)==null?void 0:t.cars)??[];return e.length?((i=window.__pf)==null?void 0:i.drivingCar)??e[Math.abs(this.carIdx)%e.length]:null}get dmgSys(){return window.__pfDamage??null}_vb(e){var t;return(t=e==null?void 0:e.components)==null?void 0:t.find(i=>i.rb&&i.suspension)}toggle(e=!this.active){var t;this.active=e,(t=document.exitPointerLock)==null||t.call(document),this.btn.classList.toggle("pf-on",e),this.panel.style.display=e?"block":"none",e&&(this._refresh(),this._syncSliders())}_hit(e){const t=this.car;t&&this.dmgSys&&(this.dmgSys.testHit(t,e,this.side),this._refresh())}_cycleWheel(e){var a,n,r,l,d,f;const t=this._vb(this.car);if(!t)return;const i=!!((a=t._flat)!=null&&a[e]),s=!!((n=t._locked)!=null&&n[e]);!!((r=t._detached)!=null&&r[e])?(t.setWheelDetached(e,!1),t.setWheelLocked(e,!1),(l=t.setWheelFlat)==null||l.call(t,e,!1)):s?(t.setWheelLocked(e,!1),t.setWheelDetached(e,!0)):i?((d=t.setWheelFlat)==null||d.call(t,e,!1),t.setWheelLocked(e,!0)):(f=t.setWheelFlat)==null||f.call(t,e,!0),this._refresh()}_refresh(){const e=this.car,t=this._vb(e);this.panel.querySelector("[data-car]").textContent=e?`${e.specName??"car"} · dmg ${(e.damage??0).toFixed(1)} · smoke ${(e.smokeDmg??0).toFixed(1)}`:"(no car)",this.panel.querySelectorAll("[data-side]").forEach(s=>s.classList.toggle("pf-sel",s.dataset.side===this.side));const i=["FL","FR","RL","RR"];this.panel.querySelectorAll("[data-wheel]").forEach(s=>{var n,r,l;const o=+s.dataset.wheel,a=(n=t==null?void 0:t._detached)!=null&&n[o]?"OFF":(r=t==null?void 0:t._locked)!=null&&r[o]?"LOCK":(l=t==null?void 0:t._flat)!=null&&l[o]?"FLAT":"ok";s.textContent=`${i[o]}: ${a}`,s.classList.toggle("pf-sel",a!=="ok")})}update(){var o;if(!this.active)return;document.pointerLockElement&&((o=document.exitPointerLock)==null||o.call(document));const e=this.car;if(!(e!=null&&e.position))return;const t=this.world.camera,i=Math.cos(this.pitch),s=Math.sin(this.pitch);t.position.set(e.position.x+Math.cos(this.yaw)*i*this.dist,e.position.y+s*this.dist,e.position.z+Math.sin(this.yaw)*i*this.dist),t.lookAt(e.position.x,e.position.y+.6,e.position.z),(this._t=(this._t??0)+1)%30===0&&this._refresh()}_buildUI(){if(!document.getElementById("pf-vtest-css")){const e=document.createElement("style");e.id="pf-vtest-css",e.textContent=`
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
      </div>`,this.panel.addEventListener("click",e=>{const t=e.target.closest("button");if(t){if(t.dataset.side)this.side=t.dataset.side;else if(t.dataset.sev)this._hit(+t.dataset.sev);else if(t.dataset.wheel)this._cycleWheel(+t.dataset.wheel);else if(t.dataset.smoke!==void 0){const i=this.car;i&&(i.smokeDmg=+t.dataset.smoke)}else if(t.dataset.act==="reset"){const i=this.car;i&&this.dmgSys&&this.dmgSys.resetCar(i)}else if(t.dataset.act==="tunereset"){for(const[i,s]of Object.entries(he.KNOB_DEFAULTS))this._setKnob(i,s);this._syncSliders()}this._refresh()}}),this.panel.addEventListener("input",e=>{const t=e.target.closest("input[type=range]");if(!t)return;const i=t.dataset.knob,s=+t.value;this._setKnob(i,s),this._kvText(i,s)}),document.body.appendChild(this.panel)}_kvText(e,t){const i=e==="sideFriction"||e==="rearGripMul"||e==="_airGrav",s=this.panel.querySelector(`[data-kv="${e}"]`);s&&(s.textContent=(+t).toFixed(i?2:0))}_setKnob(e,t){var i,s,o;for(const a of((i=window.__pf)==null?void 0:i.cars)??[]){const n=(s=a.components)==null?void 0:s.find(r=>r.rb&&r.suspension);if(n)if(e==="suspStiff"){n.suspStiff=t;for(let r=0;r<4;r++)(o=n.ctrl)==null||o.setWheelSuspensionStiffness(r,t)}else n[e]=t}}_syncSliders(){const e=this._vb(this.car);if(e)for(const t of Object.keys(he.KNOB_DEFAULTS)){const i=t==="_airGrav"?e._airGrav??he.KNOB_DEFAULTS._airGrav:e[t];if(i==null)continue;const s=this.panel.querySelector(`input[data-knob="${t}"]`);s&&(s.value=i),this._kvText(t,i)}}}he.KNOB_DEFAULTS={enginePower:10,topSpeed:38,brakePower:15,sideFriction:.8,rearGripMul:1,_airGrav:.5,suspStiff:42};export{hi as B,Se as C,st as E,ai as F,di as P,fi as S,oi as V,li as W,he as a,ci as r};
