'use strict';
/*
Based on:
https://github.com/ldn0x7dc/react-native-view-transformer.git

Some cherry picking from:
https://github.com/maraujop/react-native-view-transformer.git

New features:
- overlay an image with high resolution graphics
- overlay screen with arbitrary stuff
- Convert between screen coords <-> image coords

At the moment react-native-svg won't keep the resolution on rasterized vectors
when painted upon a scaled down view, The only solution I found was to paint the
svg on a large view and transform this view down separately to match the image view.

The overlayed svg view has its own transform parameters which are recalculated
to match the original view.

N.B this module is subject to refactoring and development. Do not trust on it's
stability.

Terminology:
- Screen: the visible paint area, i.e. the physical pixels on the device are the limits
- Image: Underlaying image. Often much bigger than the Screen
- Overlay: SVG elements painted on top of the image at the native image resolution
- Coordinate: A point on the image expressed as a decimal percentage, 0.5;0.5 is in the middle of the image
- ScreenPoint: A point on the screen expressed in pixels from top-left of the screen
- SvgPoint: a point on the svg overlay expressed in pixels from top-left of svg
- ClipRect: the currently shown rect of the image expressed as coordinates (0;0, 1;1) = complete image
- DrawingScalar: a scalar expressed as a percentage of the long side of the drawing
  i.e. DrawingScalar=0.1, svgWidth=2000 -> ScreenScalar = 200
- ScreenScalar: a scalar expressed in svcreen pixels
*/

import React from 'react';
import ReactNative, {
  View,
  Animated,
  ActivityIndicator,
  Easing,
  NativeModules
} from 'react-native';

import {createResponder} from 'react-native-gesture-responder';
import Scroller from 'react-native-scroller';
import {Rect, Transform, transformedRect, availableTranslateSpace, fitCenterRect, alignedRect, getTransform} from './TransformUtils';

export default class ViewTransformer extends React.Component {
  static Rect = Rect;
  static getTransform = getTransform;

  constructor(props) {
    super(props);
    this.state = {
      //transform state
      scale: 10,
      translateX: 30,
      translateY: 0,

      //animation state
      animator: new Animated.Value(0),

      svgScale: 1,  //1 = fit image on screen
      svgTranslateX: 0,
      svgTranslateY: 0,
      svgDrawingScale: 0, //1 = full resolution

      //layout
      width: 0,
      height: 0,
      pageX: 0,
      pageY: 0,

      isAnimating: false
    };

    this._viewPortRect = new Rect(); //A holder to avoid new too much

    this._svgRect = (this.props.svgWidth && this.props.svgHeight)
      ? new Rect()
      : null  //null means "no valid svg props"

    this.cancelAnimation = this.cancelAnimation.bind(this);
    this.contentRect = this.contentRect.bind(this);
    this.transformedContentRect = this.transformedContentRect.bind(this);
    this.animate = this.animate.bind(this);

    this.scroller = new Scroller(true, (dx, dy, scroller) =>{
      if (dx === 0 && dy === 0 && scroller.isFinished()) {
        this.animateBounce();
        return;
      }

      this.updateTransform({
        translateX: this.state.translateX + dx / this.state.scale,
        translateY: this.state.translateY + dy / this.state.scale
      })
    });
  }

  viewPortRect() {
    this._viewPortRect.set(0, 0, this.state.width, this.state.height);
    return this._viewPortRect;
  }

  svgRect() {
    if(!this._svgRect) return null;

    this._svgRect.set(0, 0, this.props.svgWidth, this.props.svgHeight);
    return this._svgRect;
  }

  contentRect() {
    let rect = this.viewPortRect().copy();
    if (this.props.contentAspectRatio && this.props.contentAspectRatio > 0) {
      rect = fitCenterRect(this.props.contentAspectRatio, rect);
    }
    return rect;
  }

  transformedContentRect() {
    let rect = transformedRect(this.viewPortRect(), this.currentTransform());
    if (this.props.contentAspectRatio && this.props.contentAspectRatio > 0) {
      rect = fitCenterRect(this.props.contentAspectRatio, rect);
    }
    return rect;
  }

  //clipRectCoordinates is the painted area relative to the image, i.e.
  //left >= 0, right <= 1
  //top => 0, bottom <= 1
  clipRectCoordinates = () => {
    let content = this.contentRect()
    let transform = this.currentTransform()
    let transformed = this.transformedContentRect()
    let viewPort = this.viewPortRect()

    let centerX = 0.5 - transform.translateX / content.width()
    let centerY = 0.5 - transform.translateY / content.height()
    let width = viewPort.width() / transformed.width()
    let height = viewPort.height() / transformed.height()

    return new Rect(
      Math.max(0, centerX - width/2),   //left
      Math.max(0, centerY - height/2),  //top
      Math.min(1, centerX + width/2),   //right
      Math.min(1, centerY + height/2)   //bottom
    );
  }
  //
  // screenPointToDrawingPoint = (screenPoint) => {
  //   let tr = this.transformedContentRect();
  //   return {
  //     x: (screenPoint.x - tr.left) / this.state.svgDrawingScale,
  //     y: (screenPoint.y - tr.top) / this.state.svgDrawingScale
  //   }
  // }

  clipRect = () => {
    let clipRectCoordinates = this.clipRectCoordinates()
    // let content = this.contentRect();
    // let transform = this.currentTransform();
    // let transformed = this.transformedContentRect();
    // let viewPort = this.viewPortRect();
    //
    // let centerX = 0.5 - transform.translateX / content.width();
    // let centerY = 0.5 - transform.translateY / content.height();
    //
    // let width = viewPort.width() / transformed.width()
    // let height = viewPort.height() / transformed.height()

    // return new Rect(
    //   Math.max(0, centerX - width/2) * this.props.svgWidth,   //left
    //   Math.max(0, centerY - height/2) * this.props.svgHeight,  //top
    //   Math.min(1, centerX + width/2) * this.props.svgWidth,   //right
    //   Math.min(1, centerY + height/2) * this.props.svgHeight   //bottom
    // );
    return new Rect(
      clipRectCoordinates.left * this.props.svgWidth,   //left
      clipRectCoordinates.top * this.props.svgHeight,  //top
      clipRectCoordinates.right * this.props.svgWidth,   //right
      clipRectCoordinates.bottom * this.props.svgHeight   //bottom
    );

  }

  currentTransform() {
    return new Transform(this.state.scale, this.state.translateX, this.state.translateY);
  }

  currentSvgTransform() {
    return new Transform(this.state.svgScale, this.state.svgTranslateX, this.state.svgTranslateY);
  }

  componentWillMount() {
    this.gestureResponder = createResponder({
      onStartShouldSetResponder: (evt, gestureState) => true,
      onMoveShouldSetResponderCapture: (evt, gestureState) => true,
      //onMoveShouldSetResponder: this.handleMove,
      onResponderMove: this.onResponderMove.bind(this),
      onResponderGrant: this.onResponderGrant.bind(this),
      onResponderRelease: this.onResponderRelease.bind(this),
      onResponderTerminate: this.onResponderRelease.bind(this),
      onResponderTerminationRequest: (evt, gestureState) => false, //Do not allow parent view to intercept gesture
      onResponderSingleTapConfirmed: (evt, gestureState) => {
        this.props.onSingleTapConfirmed && this.props.onSingleTapConfirmed();
      },
      onResponderTerminationRequest: (evt, gestureState) => false //Do not allow parent view to intercept gesture
    });
  }

  componentDidUpdate(prevProps, prevState) {
    this.props.onViewTransformed && this.props.onViewTransformed({
      scale: this.state.scale,
      translateX: this.state.translateX,
      translateY: this.state.translateY
    });
  }

  componentWillUnmount() {
    this.cancelAnimation();
  }

  render() {
    let gestureResponder = this.gestureResponder;
    if (!this.props.enableTransform) {
      gestureResponder = {};
    }

    return (
      <View
        {...this.props}
        {...gestureResponder}
        ref={'innerViewRef'}
        onLayout={this.onLayout.bind(this)}>
        <View
          style={{
            flex: 1,
            transform: [
                  {scale: this.state.scale},
                  {translateX: this.state.translateX},
                  {translateY: this.state.translateY}
                ]
          }}>
          {this.props.children}
          {this.renderOverlay()}
        </View>
        {this.renderScreen()}
        {this.props.renderActivityIndicator() && this.props.renderActivityIndicator()}
      </View>
    );
  }

  //"Overlay" is rendered over the complete undelaying image, even the
  //parts not shown on screen right now. This should be rendered only
  //once when it needs to update. Interactive changes only takes place on
  //screen and should be handled by renderScreen()
  renderOverlay = () => {
    if(!this._svgRect || !this.props.renderOverlay) return null;

    return (
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: this.props.svgWidth,
          height: this.props.svgHeight,
          transform: [
            {scale: this.state.svgScale},
            {translateX: this.state.svgTranslateX},
            {translateY: this.state.svgTranslateY}
          ]
        }}>
        {this.props.renderOverlay && this.props.renderOverlay({
          clipRect: this.clipRect(),
          viewPortRect: this.viewPortRect()
        }, {
          coordinateToScreenPoint: this.coordinateToScreenPoint,
          screenPointToCoordinate: this.screenPointToCoordinate,
          coordinateToSvgPoint: this.coordinateToSvgPoint,
          onFinishedPainting: this.onFinishedPainting,
          drawingPointToScreenPoint: this.drawingPointToScreenPoint
        })}
      </View>
    );
  }

  //RenderScreen should only paint "on screen", i.e. screen coordinates
  //and screen touches should drive this rendering
  renderScreen = () => {
    if(!this.props.renderScreen) return null;

    return (
      <View style={{position: 'absolute', left: 0, top: 0, width: this.state.width, height: this.state.height}}>
        {this.props.renderScreen && this.props.renderScreen({
          clipRect: this.clipRect(),
          viewPortRect: this.viewPortRect(),
          contentRect: this.contentRect(),
          transformedContentRect: this.transformedContentRect(),
          isAnimating: this.state.isAnimating,
          isZooming: this.state.isZooming,
          scale: this.state.scale,
          svgDrawingScale: this.state.svgDrawingScale,
          translateX: this.state.translateX,
          translateY: this.state.translateY,

        }, {
          coordinateToScreenPoint: this.coordinateToScreenPoint,
          screenPointToCoordinate: this.screenPointToCoordinate,
          screenScalarToDrawingScalar: this.screenScalarToDrawingScalar,
          drawingScalarToScreenScalar: this.drawingScalarToScreenScalar,
          drawingPointToScreenPoint: this.drawingPointToScreenPoint
        })}
      </View>
    );
  }

  //Convert a relative coordinate (ex: {x: 0.55, y: 0.85})
  //to a point on the svg overlay
  coordinateToSvgPoint = (coord) => {
    if(!this._svgRect) return coord

    return {
      x: coord.x * this.props.svgWidth,
      y: coord.y * this.props.svgHeight
    }
  }

  //Convert a coordinate on underlaying image to a local screen point
  //Use this for placing stationary controls on screen in renderScreen()
  coordinateToScreenPoint = (drawingPoint) => {
    let tr = this.transformedContentRect();
    let co = this.contentRect();
    return {
      x: drawingPoint.x * tr.width() + tr.left,
      y: drawingPoint.y * tr.height() + tr.top
    }
  }

  //Convert a coordinate on underlaying image to a local screen point
  //Use this for placing stationary controls on screen in renderScreen()
  drawingPointToScreenPoint = (drawingPoint) => {
    let tr = this.transformedContentRect();
    return {
      x: tr.left + drawingPoint.x * this.state.svgDrawingScale,
      y: tr.top + drawingPoint.y * this.state.svgDrawingScale
    }
  }

  //Convert a coordinate on underlaying image to a local screen point
  //Use this for placing stationary controls on screen in renderScreen()
  screenPointToDrawingPoint = (screenPoint) => {
    let tr = this.transformedContentRect();
    return {
      x: (screenPoint.x - tr.left) / this.state.svgDrawingScale,
      y: (screenPoint.y - tr.top) / this.state.svgDrawingScale
    }
  }

  drawingScalarToScreenScalar = (drawingScalar) => {
    let tr = this.transformedContentRect();
    let co = this.contentRect();
    return drawingScalar * Math.max(tr.width(), tr.height())
  }

  screenScalarToDrawingScalar = (screenScalar) => {
    let tr = this.transformedContentRect();
    let co = this.contentRect();
    return screenScalar / this.state.svgDrawingScale
  }

  //Convert a point on the visible screen (i.e. from touch event)
  //to a coordinate on the underlaying image
  screenPointToCoordinate = (screenPoint) => {
    let tr = this.transformedContentRect();
    let co = this.contentRect();

    return {
      x: (screenPoint.x - tr.left ) / tr.width(),
      y: (screenPoint.y - tr.top) / tr.height()
    }
  }

  onLayout(e) {
    const {width, height} = e.nativeEvent.layout;
    if(width !== this.state.width || height !== this.state.height) {
      this.setState({width, height}, () => {
        this.updateSvgTransform();
      });
    }
    this.measureLayout();

    this.props.onLayout && this.props.onLayout(e);
  }

  measureLayout() {
    let handle = ReactNative.findNodeHandle(this.refs['innerViewRef']);
    NativeModules.UIManager.measure(handle, ((x, y, width, height, pageX, pageY) => {
      if(typeof pageX === 'number' && typeof pageY === 'number') { //avoid undefined values on Android devices
        if(this.state.pageX !== pageX || this.state.pageY !== pageY) {
          this.setState({
            pageX: pageX,
            pageY: pageY
          });
        }
      }

    }).bind(this));
  }

  onResponderGrant(evt, gestureState) {
    this.props.onTransformStart && this.props.onTransformStart();
    this.setState({responderGranted: true});
    this.measureLayout();
  }

  onResponderMove(evt, gestureState) {
    this.cancelAnimation();

    let handled = this.props.onTransformGestureMove && this.props.onTransformGestureMove()
    if(handled) {
      return
    }

    let dx = gestureState.moveX - gestureState.previousMoveX;
    let dy = gestureState.moveY - gestureState.previousMoveY;

    if (this.props.enableLimits) {
      let d = this.applyLimits(dx, dy);
      dx = d.dx;
      dy = d.dy;
    } else if (this.props.enableResistance) {
      let d = this.applyResistance(dx, dy);
      dx = d.dx;
      dy = d.dy;
    }

    if(!this.props.enableTranslate) {
      dx = dy = 0;
    }


    let transform = {};
    if (gestureState.previousPinch && gestureState.pinch && this.props.enableScale) {

let dx = gestureState.moveX - gestureState.previousMoveX;
let dy = gestureState.moveY - gestureState.previousMoveY;


      let scaleBy = gestureState.pinch / gestureState.previousPinch;
      let pivotX = gestureState.moveX - this.state.pageX;
      let pivotY = gestureState.moveY - this.state.pageY;

      let rect = transformedRect(transformedRect(this.contentRect(), this.currentTransform()), new Transform(
        scaleBy, dx, dy,
        {
          x: pivotX,
          y: pivotY
        }
      ));
      transform = getTransform(this.contentRect(), rect);
    } else {
      if (Math.abs(dx) > 2 * Math.abs(dy)) {
        dy = 0;
      } else if (Math.abs(dy) > 2 * Math.abs(dx)) {
        dx = 0;
      }
      transform.translateX = this.state.translateX + dx / this.state.scale;
      transform.translateY = this.state.translateY + dy / this.state.scale;
    }

    this.updateTransform(transform);
    return true;
  }

  onResponderRelease(evt, gestureState) {
    let drawingPoint = this.screenPointToDrawingPoint({x: gestureState.x0, y: gestureState.y0})
    let handled = this.props.onTransformGestureReleased && this.props.onTransformGestureReleased(
      {
        scale: this.state.scale,
        translateX: this.state.translateX,
        translateY: this.state.translateY,
        svgDrawingScale: this.state.svgDrawingScale,
        drawingPoint: drawingPoint,
        gestureState: gestureState
      },
      {
        screenScalarToDrawingScalar: this.screenScalarToDrawingScalar,
        drawingPointToScreenPoint: this.drawingPointToScreenPoint
      }
    );

    if (handled) {
      return;
    }

    if (gestureState.doubleTapUp) {
      if (!this.props.enableScale) {
        this.animateBounce();
        return;
      }
      let pivotX = 0, pivotY = 0;
      if (gestureState.dx || gestureState.dy) {
        pivotX = gestureState.moveX - this.state.pageX;
        pivotY = gestureState.moveY - this.state.pageY;
      } else {
        pivotX = gestureState.x0 - this.state.pageX;
        pivotY = gestureState.y0 - this.state.pageY;
      }

      this.performDoubleTapUp(pivotX, pivotY);
    } else {
      if(this.props.enableTranslate) {
        this.performFling(gestureState.vx, gestureState.vy);
      } else {
        this.animateBounce();
      }
    }
  }

  performFling(vx, vy) {
    let startX = 0;
    let startY = 0;
    let maxX, minX, maxY, minY;
    let availablePanDistance = availableTranslateSpace(this.transformedContentRect(), this.viewPortRect());
    if (vx > 0) {
      minX = 0;
      if (availablePanDistance.left > 0) {
        maxX = availablePanDistance.left + this.props.maxOverScrollDistance;
      } else {
        maxX = 0;
      }
    } else {
      maxX = 0;
      if (availablePanDistance.right > 0) {
        minX = -availablePanDistance.right - this.props.maxOverScrollDistance;
      } else {
        minX = 0;
      }
    }
    if (vy > 0) {
      minY = 0;
      if (availablePanDistance.top > 0) {
        maxY = availablePanDistance.top + this.props.maxOverScrollDistance;
      } else {
        maxY = 0;
      }
    } else {
      maxY = 0;
      if (availablePanDistance.bottom > 0) {
        minY = -availablePanDistance.bottom - this.props.maxOverScrollDistance;
      } else {
        minY = 0;
      }
    }

    vx *= 1000; //per second
    vy *= 1000;
    if (Math.abs(vx) > 2 * Math.abs(vy)) {
      vy = 0;
    } else if (Math.abs(vy) > 2 * Math.abs(vx)) {
      vx = 0;
    }

    // this.setState({isAnimating: true})
    this.scroller.fling(startX, startY, vx, vy, minX, maxX, minY, maxY);
  }

  performDoubleTapUp(pivotX, pivotY) {
    console.log('performDoubleTapUp...pivot=' + pivotX + ', ' + pivotY);
    this.setState({isAnimating: true})
    let curScale = this.state.scale;
    let scaleBy;
    if (curScale > (1 + this.props.maxScale) / 2) {
      scaleBy = 1 / curScale;
    } else {
      scaleBy = this.props.maxScale / curScale;
    }

    let rect = transformedRect(this.transformedContentRect(), new Transform(
      scaleBy, 0, 0,
      {
        x: pivotX,
        y: pivotY
      }
    ));
    rect = transformedRect(rect, new Transform(1, this.viewPortRect().centerX() - pivotX, this.viewPortRect().centerY() - pivotY));
    rect = alignedRect(rect, this.viewPortRect());

    this.animate(rect);
  }

  //applyLimits function from:
  //https://github.com/maraujop/react-native-view-transformer.git
  applyLimits(dx, dy) {
    let availablePanDistance = availableTranslateSpace(
      this.transformedContentRect(),
      this.viewPortRect()
    );

    // Calculate until where can the view be moved
    // This depends if the view is bigger / smaller than the viewport
    if (this.transformedContentRect().width() < this.viewPortRect().width()) {
      if (
        dx < 0 &&
        this.transformedContentRect().left + dx < this.viewPortRect().left
      ) {
          dx = availablePanDistance.left;
      } else if (
        dx > 0 &&
        this.transformedContentRect().right + dx > this.viewPortRect().right
      ) {
          dx = -availablePanDistance.right;
      }
    } else {
      if (
        dx < 0 &&
        this.transformedContentRect().right + dx < this.viewPortRect().right
      ) {
          dx = -availablePanDistance.right;
      } else if (
        dx > 0 &&
        this.transformedContentRect().left + dx > this.viewPortRect().left
      ) {
          dx = availablePanDistance.left;
      }
    }

    if (this.transformedContentRect().height() < this.viewPortRect().height()) {
      if (
        dy > 0 &&
        this.transformedContentRect().bottom + dy > this.viewPortRect().bottom
      ) {
          dy = -availablePanDistance.bottom;
      } else if (
        dy < 0 &&
        this.transformedContentRect().top + dy < this.viewPortRect().top
      ) {
          dy = availablePanDistance.top;
      }
    } else {
      if (
        dy > 0 &&
        this.transformedContentRect().top + dy > this.viewPortRect().top
      ) {
          dy = availablePanDistance.top;
      } else if (
        dy < 0 &&
        this.transformedContentRect().bottom + dy < this.viewPortRect().bottom
      ) {
          dy = -availablePanDistance.bottom;
      }
    }

    return { dx, dy }
  }

  applyResistance(dx, dy) {
    let availablePanDistance = availableTranslateSpace(this.transformedContentRect(), this.viewPortRect());

    if ((dx > 0 && availablePanDistance.left < 0)
      ||
      (dx < 0 && availablePanDistance.right < 0)) {
      dx /= 3;
    }
    if ((dy > 0 && availablePanDistance.top < 0)
      ||
      (dy < 0 && availablePanDistance.bottom < 0)) {
      dy /= 3;
    }
    return {
      dx, dy
    }
  }

  cancelAnimation() {
    this.state.animator.stopAnimation();
  }

  animate(targetRect, durationInMillis) {
    let duration = 200;
    if (durationInMillis) {
      duration = durationInMillis;
    }

    let fromRect = this.transformedContentRect();
    if (fromRect.equals(targetRect)) {
      console.log('animate...equal rect, skip animation');
      return;
    }

    this.state.animator.removeAllListeners();
    this.state.animator.setValue(0);
    this.state.animator.addListener((state) =>{
      let progress = state.value;

      let left = fromRect.left + (targetRect.left - fromRect.left) * progress;
      let right = fromRect.right + (targetRect.right - fromRect.right) * progress;
      let top = fromRect.top + (targetRect.top - fromRect.top) * progress;
      let bottom = fromRect.bottom + (targetRect.bottom - fromRect.bottom) * progress;

      let transform = getTransform(this.contentRect(), new Rect(left, top, right, bottom));
      this.updateTransform(transform);
    });

    // this.setState({isAnimating: true})

    Animated.timing(this.state.animator, {
      toValue: 1,
      duration: duration,
      easing: Easing.inOut(Easing.ease)
    }).start((endState => {
      this.setState({isAnimating: false})
    }));
  }

  animateBounce() {
    let curScale = this.state.scale;
    let minScale = 1;
    let maxScale = this.props.maxScale;
    let scaleBy = 1;
    if (curScale > maxScale) {
      scaleBy = maxScale / curScale;
    } else if (curScale < minScale) {
      scaleBy = minScale / curScale;
    }

    let rect = transformedRect(this.transformedContentRect(), new Transform(
      scaleBy,
      0,
      0,
      {
        x: this.viewPortRect().centerX(),
        y: this.viewPortRect().centerY()
      }
    ));
    rect = alignedRect(rect, this.viewPortRect());
    this.animate(rect);
  }

  // Above are private functions. Do not use them if you don't known what you are doing.
  // ***********************************************************************************
  // Below are public functions. Feel free to use them.


  updateTransform(transform) {
    this.setState(transform, () => {
      this.updateSvgTransform()
    });
  }

  //Piggyback the shape and position of contentRect so that
  //the svgRect fits exactly above in a synchronized way
  updateSvgTransform = () => {
    if(!this._svgRect) return;

    let newSvgTransform = getTransform(this.svgRect(), this.contentRect());

    this.setState({
      svgScale: newSvgTransform.scale,
      svgTranslateX: newSvgTransform.translateX,
      svgTranslateY: newSvgTransform.translateY,
      svgDrawingScale: this.transformedContentRect().width() / this.props.svgWidth
    })
  }

  //I see no meaning with this function, but will keep it for compatibility
  //with original documentation
  forceUpdateTransform(transform) {
    this.updateTransform(transform);
  }

  getAvailableTranslateSpace() {
    return availableTranslateSpace(this.transformedContentRect(), this.viewPortRect());
  }
}

ViewTransformer.propTypes = {
  /**
   * Use false to disable transform. Default is true.
   */
  enableTransform: React.PropTypes.bool,

  /**
   * Use false to disable scaling. Default is true.
   */
  enableScale: React.PropTypes.bool,


  /**
   * Use false to disable translateX/translateY. Default is true.
   */
  enableTranslate: React.PropTypes.bool,

  /**
   * Default is 20
   */
  maxOverScrollDistance: React.PropTypes.number,

  maxScale: React.PropTypes.number,
  contentAspectRatio: React.PropTypes.number,

  /**
   * Use true to enable resistance effect on over pulling. Default is false.
   */
  enableResistance: React.PropTypes.bool,

  onViewTransformed: React.PropTypes.func,

  onTransformGestureReleased: React.PropTypes.func,
  onSingleTapConfirmed: React.PropTypes.func,

  svgWidth: React.PropTypes.number,
  svgHeight: React.PropTypes.number,
  enableLimits: React.PropTypes.bool,
  renderOverlay: React.PropTypes.func,
  renderScreen: React.PropTypes.func
};
ViewTransformer.defaultProps = {
  maxOverScrollDistance: 0,
  enableScale: true,
  enableTranslate: true,
  enableTransform: true,
  maxScale: 1,
  enableResistance: false,
  enableLimits: false
};
