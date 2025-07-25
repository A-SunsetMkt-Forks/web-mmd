import {
	BlendFunction,
	ColorChannel,
	Effect,
	EffectAttribute,
	KawaseBlurPass,
	KernelSize, MaskFunction,
	MaskMaterial,
	RenderPass,
	Resolution,
	ShaderPass,
	OverrideMaterialManager,
	BokehMaterial
} from "postprocessing";
import { BasicDepthPacking, Camera, Color, DepthPackingStrategies, PerspectiveCamera, Scene, SRGBColorSpace, Texture, TextureDataType, Uniform, UnsignedByteType, Vector3, WebGLRenderer, WebGLRenderTarget } from "three";

import { CircleOfConfusionMaterial } from "./CircleOfConfusionMaterial";
import { RealisiticDepthMaterial } from "./RealisiticDepthMaterial";
import fragmentShader from "./shaders/dof.frag";
import { getOutputColorSpace, setTextureColorSpace, viewZToOrthographicDepth } from "./utils/all";

OverrideMaterialManager.workaroundEnabled = true;
/**
 * A depth of field effect.
 *
 * Based on a graphics study by Adrian Courrèges and an article by Steve Avery:
 * https://www.adriancourreges.com/blog/2016/09/09/doom-2016-graphics-study/
 * https://pixelmischiefblog.wordpress.com/2016/11/25/bokeh-depth-of-field/
 */

type BokehPass = ShaderPass & {fullscreenMaterial: BokehMaterial}
type CocPass = ShaderPass & {fullscreenMaterial: CircleOfConfusionMaterial}
type MaskPass = ShaderPass & {fullscreenMaterial: MaskMaterial}

export class DepthOfFieldEffect extends Effect {
	camera: PerspectiveCamera;
	renderTarget: WebGLRenderTarget;
	renderTargetMasked: WebGLRenderTarget;
	renderTargetDepth: WebGLRenderTarget;
	renderTargetNear: WebGLRenderTarget;
	renderTargetFar: WebGLRenderTarget;
	renderTargetCoC: WebGLRenderTarget;
	renderTargetCoCBlurred: WebGLRenderTarget;
	depthPass: RenderPass
	cocPass: CocPass;
	blurPass: KawaseBlurPass;
	maskPass: MaskPass;
	bokehNearBasePass: BokehPass;
	bokehNearFillPass: BokehPass;
	bokehFarBasePass: BokehPass;
	bokehFarFillPass: BokehPass;
	target: Vector3;
	resolution: Resolution;
	scene: Scene;

	/**
	 * Constructs a new depth of field effect.
	 *
	 * @param {Camera} camera - The main camera.
	 * @param {Object} [options] - The options.
	 * @param {BlendFunction} [options.blendFunction] - The blend function of this effect.
	 * @param {Number} [options.worldFocusDistance] - The focus distance in world units.
	 * @param {Number} [options.worldFocusRange] - The focus distance in world units.
	 * @param {Number} [options.focusDistance=0.0] - The normalized focus distance. Range is [0.0, 1.0].
	 * @param {Number} [options.focusRange=0.1] - The focus range. Range is [0.0, 1.0].
	 * @param {Number} [options.focalLength=0.1] - Deprecated.
	 * @param {Number} [options.bokehScale=1.0] - The scale of the bokeh blur.
	 * @param {Number} [options.resolutionScale=0.5] - The resolution scale.
	 * @param {Number} [options.resolutionX=Resolution.AUTO_SIZE] - The horizontal resolution.
	 * @param {Number} [options.resolutionY=Resolution.AUTO_SIZE] - The vertical resolution.
	 * @param {Number} [options.width=Resolution.AUTO_SIZE] - Deprecated. Use resolutionX instead.
	 * @param {Number} [options.height=Resolution.AUTO_SIZE] - Deprecated. Use resolutionY instead.
	 */

	constructor(scene: Scene, camera: PerspectiveCamera, {
		blendFunction,
		worldFocusDistance,
		worldFocusRange,
		focusDistance = 0.0,
		focalLength = 0.1,
		focusRange = focalLength,
		bokehScale = 1.0,
		resolutionScale = 1.0,
		width = Resolution.AUTO_SIZE,
		height = Resolution.AUTO_SIZE,
		resolutionX = width,
		resolutionY = height
	}: { blendFunction?: BlendFunction; worldFocusDistance?: number; worldFocusRange?: number; focusDistance?: number; focusRange?: number; focalLength?: number; bokehScale?: number; resolutionScale?: number; resolutionX?: number; resolutionY?: number; width?: number; height?: number; } = {}) {

		super("DepthOfFieldEffect", fragmentShader, {
			blendFunction,
			uniforms: new Map([
				["nearColorBuffer", new Uniform(null)],
				["farColorBuffer", new Uniform(null)],
				["nearCoCBuffer", new Uniform(null)],
				["farCoCBuffer", new Uniform(null)],
				["scale", new Uniform(1.0)]
			])
		});

		/**
		 * The main camera.
		 *
		 * @type {Camera}
		 * @private
		 */

		this.camera = camera;
		this.scene = scene;

		/**
		 * A render target for intermediate results.
		 *
		 * @type {WebGLRenderTarget}
		 * @private
		 */

		this.renderTarget = new WebGLRenderTarget(1, 1, { depthBuffer: false });
		this.renderTarget.texture.name = "DoF.Intermediate";

		this.renderTargetDepth = new WebGLRenderTarget(1, 1);
		this.renderTargetDepth.texture.name = "DoF.Depth";

		/**
		 * A render target for masked background colors (premultiplied with CoC).
		 *
		 * @type {WebGLRenderTarget}
		 * @private
		 */

		this.renderTargetMasked = this.renderTarget.clone();
		this.renderTargetMasked.texture.name = "DoF.Masked.Far";

		/**
		 * A render target for the blurred foreground colors.
		 *
		 * @type {WebGLRenderTarget}
		 * @private
		 */

		this.renderTargetNear = this.renderTarget.clone();
		this.renderTargetNear.texture.name = "DoF.Bokeh.Near";
		this.uniforms.get("nearColorBuffer").value = this.renderTargetNear.texture;

		/**
		 * A render target for the blurred background colors.
		 *
		 * @type {WebGLRenderTarget}
		 * @private
		 */

		this.renderTargetFar = this.renderTarget.clone();
		this.renderTargetFar.texture.name = "DoF.Bokeh.Far";
		this.uniforms.get("farColorBuffer").value = this.renderTargetFar.texture;

		/**
		 * A render target for the circle of confusion.
		 *
		 * - Negative values are stored in the `RED` channel (foreground).
		 * - Positive values are stored in the `GREEN` channel (background).
		 *
		 * @type {WebGLRenderTarget}
		 * @private
		 */

		this.renderTargetCoC = this.renderTarget.clone();
		this.renderTargetCoC.texture.name = "DoF.CoC";
		this.uniforms.get("farCoCBuffer").value = this.renderTargetCoC.texture;

		/**
		 * A render target that stores a blurred copy of the circle of confusion.
		 *
		 * @type {WebGLRenderTarget}
		 * @private
		 */

		this.renderTargetCoCBlurred = this.renderTargetCoC.clone();
		this.renderTargetCoCBlurred.texture.name = "DoF.CoC.Blurred";
		this.uniforms.get("nearCoCBuffer").value = this.renderTargetCoCBlurred.texture;

		// Depth pass
		this.depthPass = new RenderPass(scene, camera, new RealisiticDepthMaterial(camera));

		const clearPass = this.depthPass.clearPass;
		clearPass.overrideClearColor = new Color(0xffffff);
		clearPass.overrideClearAlpha = 1;

		/**
		 * A circle of confusion pass.
		 *
		 * @type {ShaderPass}
		 * @private
		 */

		this.cocPass = new ShaderPass(new CircleOfConfusionMaterial(this.renderTargetDepth.texture, camera)) as CocPass;
		const cocMaterial = this.cocMaterial;
		cocMaterial.focusDistance = focusDistance;
		cocMaterial.focusRange = focusRange;

		if(worldFocusDistance !== undefined) {

			cocMaterial.worldFocusDistance = worldFocusDistance;

		}

		if(worldFocusRange !== undefined) {

			cocMaterial.worldFocusRange = worldFocusRange;

		}

		/**
		 * This pass blurs the foreground CoC buffer to soften edges.
		 *
		 * @type {KawaseBlurPass}
		 * @readonly
		 */

		this.blurPass = new KawaseBlurPass({ resolutionScale, resolutionX, resolutionY, kernelSize: KernelSize.MEDIUM });

		/**
		 * A mask pass.
		 *
		 * @type {ShaderPass}
		 * @private
		 */

		this.maskPass = new ShaderPass(new MaskMaterial(this.renderTargetCoC.texture)) as MaskPass;
		const maskMaterial = this.maskPass.fullscreenMaterial;
		maskMaterial.colorChannel = ColorChannel.GREEN;
		this.maskFunction = MaskFunction.MULTIPLY_RGB;

		/**
		 * A bokeh blur pass for the foreground colors.
		 *
		 * @type {ShaderPass}
		 * @private
		 */

		this.bokehNearBasePass = new ShaderPass(new BokehMaterial(false, true)) as BokehPass;
		this.bokehNearBasePass.fullscreenMaterial.cocBuffer = this.renderTargetCoCBlurred.texture;

		/**
		 * A bokeh fill pass for the foreground colors.
		 *
		 * @type {ShaderPass}
		 * @private
		 */

		this.bokehNearFillPass = new ShaderPass(new BokehMaterial(true, true)) as BokehPass;
		this.bokehNearFillPass.fullscreenMaterial.cocBuffer = this.renderTargetCoCBlurred.texture;

		/**
		 * A bokeh blur pass for the background colors.
		 *
		 * @type {ShaderPass}
		 * @private
		 */

		this.bokehFarBasePass = new ShaderPass(new BokehMaterial(false, false)) as BokehPass;
		this.bokehFarBasePass.fullscreenMaterial.cocBuffer = this.renderTargetCoCBlurred.texture;

		/**
		 * A bokeh fill pass for the background colors.
		 *
		 * @type {ShaderPass}
		 * @private
		 */

		this.bokehFarFillPass = new ShaderPass(new BokehMaterial(true, false)) as BokehPass;
		this.bokehFarFillPass.fullscreenMaterial.cocBuffer = this.renderTargetCoCBlurred.texture;

		/**
		 * A target position that should be kept in focus. Set to `null` to disable auto focus.
		 *
		 * @type {Vector3}
		 */

		this.target = null;

		/**
		 * The render resolution.
		 *
		 * @type {Resolution}
		 * @readonly
		 */

		this.resolution = new Resolution(this, resolutionX, resolutionY, resolutionScale);

		this.bokehScale = bokehScale;

	}

	/**
	 * The circle of confusion texture.
	 *
	 * @type {Texture}
	 */

	get cocTexture() {

		return this.renderTargetCoC.texture;

	}

	/**
	 * The mask function. Default is `MULTIPLY_RGB`.
	 *
	 * @type {MaskFunction}
	 */

	get maskFunction() {

		return this.maskPass.fullscreenMaterial.maskFunction;

	}

	set maskFunction(value) {

		if(this.maskFunction !== value) {

			this.defines.set("MASK_FUNCTION", value.toFixed(0));
			this.maskPass.fullscreenMaterial.maskFunction = value;
			this.setChanged();

		}

	}

	/**
	 * The circle of confusion material.
	 *
	 * @type {CircleOfConfusionMaterial}
	 */

	get cocMaterial() {

		return this.cocPass.fullscreenMaterial;

	}

	/**
	 * The circle of confusion material.
	 *
	 * @deprecated Use cocMaterial instead.
	 * @type {CircleOfConfusionMaterial}
	 */

	get circleOfConfusionMaterial() {

		return this.cocMaterial;

	}

	/**
	 * Returns the circle of confusion material.
	 *
	 * @deprecated Use cocMaterial instead.
	 * @return {CircleOfConfusionMaterial} The material.
	 */

	getCircleOfConfusionMaterial() {

		return this.cocMaterial;

	}

	/**
	 * Returns the pass that blurs the foreground CoC buffer to soften edges.
	 *
	 * @deprecated Use blurPass instead.
	 * @return {KawaseBlurPass} The blur pass.
	 */

	getBlurPass() {

		return this.blurPass;

	}

	/**
	 * Returns the resolution settings.
	 *
	 * @deprecated Use resolution instead.
	 * @return {Resolution} The resolution.
	 */

	getResolution() {

		return this.resolution;

	}

	/**
	 * The current bokeh scale.
	 *
	 * @type {Number}
	 */

	get bokehScale() {

		return this.uniforms.get("scale").value;

	}

	set bokehScale(value) {

		this.bokehNearBasePass.fullscreenMaterial.scale = value;
		this.bokehNearFillPass.fullscreenMaterial.scale = value;
		this.bokehFarBasePass.fullscreenMaterial.scale = value;
		this.bokehFarFillPass.fullscreenMaterial.scale = value;
		this.maskPass.fullscreenMaterial.strength = value;
		this.uniforms.get("scale").value = value;

	}

	/**
	 * Returns the current bokeh scale.
	 *
	 * @deprecated Use bokehScale instead.
	 * @return {Number} The scale.
	 */

	getBokehScale() {

		return this.bokehScale;

	}

	/**
	 * Sets the bokeh scale.
	 *
	 * @deprecated Use bokehScale instead.
	 * @param {Number} value - The scale.
	 */

	setBokehScale(value: any) {

		this.bokehScale = value;

	}

	/**
	 * Returns the current auto focus target.
	 *
	 * @deprecated Use target instead.
	 * @return {Vector3} The target.
	 */

	getTarget() {

		return this.target;

	}

	/**
	 * Sets the auto focus target.
	 *
	 * @deprecated Use target instead.
	 * @param {Vector3} value - The target.
	 */

	setTarget(value: null) {

		this.target = value;

	}

	/**
	 * Calculates the focus distance from the camera to the given position.
	 *
	 * @param {Vector3} target - The target.
	 * @return {Number} The normalized focus distance.
	 */

	calculateFocusDistance(target: Vector3) {

		const camera = this.camera;
		const distance = camera.position.distanceTo(target);
		return distance / camera.far;

	}

	/**
	 * Sets the depth texture.
	 *
	 * @param {Texture} depthTexture - A depth texture.
	 * @param {DepthPackingStrategies} [depthPacking=BasicDepthPacking] - The depth packing.
	 */

	setDepthTexture(depthTexture: Texture, depthPacking: DepthPackingStrategies = BasicDepthPacking) {

		this.cocMaterial.depthBuffer = depthTexture;
		this.cocMaterial.depthPacking = depthPacking;

	}

	/**
	 * Updates this effect.
	 *
	 * @param {WebGLRenderer} renderer - The renderer.
	 * @param {WebGLRenderTarget} inputBuffer - A frame buffer that contains the result of the previous pass.
	 * @param {Number} [deltaTime] - The time between the last frame and the current one in seconds.
	 */

	update(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget<Texture>, deltaTime: any) {

		const renderTarget = this.renderTarget;
		const renderTargetCoC = this.renderTargetCoC;
		const renderTargetCoCBlurred = this.renderTargetCoCBlurred;
		const renderTargetMasked = this.renderTargetMasked;

		// Auto focus.
		if(this.target !== null) {
			const distance = this.calculateFocusDistance(this.target);
			this.cocMaterial.focusDistance = distance;
			this.cocMaterial.focusRange = this.camera.getFocalLength() / 70
		}

		// Render Depth
		this.depthPass.render(renderer, this.renderTargetDepth, null);

		// Render the CoC and create a blurred version for soft near field blending.
		this.cocPass.render(renderer, null, renderTargetCoC);
		this.blurPass.render(renderer, renderTargetCoC, renderTargetCoCBlurred);

		// Prevent sharp colors from bleeding onto the background.
		this.maskPass.render(renderer, inputBuffer, renderTargetMasked);

		// Use the sharp CoC buffer and render the background bokeh.
		this.bokehFarBasePass.render(renderer, renderTargetMasked, renderTarget);
		this.bokehFarFillPass.render(renderer, renderTarget, this.renderTargetFar);

		// Use the blurred CoC buffer and render the foreground bokeh.
		this.bokehNearBasePass.render(renderer, inputBuffer, renderTarget);
		this.bokehNearFillPass.render(renderer, renderTarget, this.renderTargetNear);

	}

	/**
	 * Updates the size of internal render targets.
	 *
	 * @param {Number} width - The width.
	 * @param {Number} height - The height.
	 */

	setSize(width: number, height: number) {

		const resolution = this.resolution;
		resolution.setBaseSize(width, height);
		const w = resolution.width, h = resolution.height;

		this.cocPass.setSize(width, height);
		this.blurPass.setSize(width, height);
		this.maskPass.setSize(width, height);

		// These buffers require full resolution to prevent color bleeding.
		this.renderTargetFar.setSize(width, height);
		this.renderTargetCoC.setSize(width, height);
		this.renderTargetMasked.setSize(width, height);
		
		this.renderTargetDepth.setSize(w, h);
		this.renderTarget.setSize(w, h);
		this.renderTargetNear.setSize(w, h);
		this.renderTargetCoCBlurred.setSize(w, h);

		// Optimization: 1 / (TexelSize * ResolutionScale) = FullResolution
		this.bokehNearBasePass.fullscreenMaterial.setSize(width, height);
		this.bokehNearFillPass.fullscreenMaterial.setSize(width, height);
		this.bokehFarBasePass.fullscreenMaterial.setSize(width, height);
		this.bokehFarFillPass.fullscreenMaterial.setSize(width, height);

	}

	/**
	 * Performs initialization tasks.
	 *
	 * @param {WebGLRenderer} renderer - The renderer.
	 * @param {Boolean} alpha - Whether the renderer uses the alpha channel or not.
	 * @param {Number} frameBufferType - The type of the main frame buffers.
	 */

	initialize(renderer: WebGLRenderer, alpha: boolean, frameBufferType: TextureDataType) {

		this.depthPass.initialize(renderer, alpha, frameBufferType);
		this.cocPass.initialize(renderer, alpha, frameBufferType);
		this.maskPass.initialize(renderer, alpha, frameBufferType);
		this.bokehNearBasePass.initialize(renderer, alpha, frameBufferType);
		this.bokehNearFillPass.initialize(renderer, alpha, frameBufferType);
		this.bokehFarBasePass.initialize(renderer, alpha, frameBufferType);
		this.bokehFarFillPass.initialize(renderer, alpha, frameBufferType);

		// The blur pass operates on the CoC buffer.
		this.blurPass.initialize(renderer, alpha, UnsignedByteType);

		if(renderer.capabilities.logarithmicDepthBuffer) {

			this.cocPass.fullscreenMaterial.defines.LOG_DEPTH = "1";

		}

		if(frameBufferType !== undefined) {

			this.renderTarget.texture.type = frameBufferType;
			this.renderTargetDepth.texture.type = frameBufferType;
			this.renderTargetNear.texture.type = frameBufferType;
			this.renderTargetFar.texture.type = frameBufferType;
			this.renderTargetMasked.texture.type = frameBufferType;

			if(getOutputColorSpace(renderer) === SRGBColorSpace) {

				setTextureColorSpace(this.renderTarget.texture, SRGBColorSpace);
				setTextureColorSpace(this.renderTargetNear.texture, SRGBColorSpace);
				setTextureColorSpace(this.renderTargetFar.texture, SRGBColorSpace);
				setTextureColorSpace(this.renderTargetMasked.texture, SRGBColorSpace);

			}

		}

	}

}
