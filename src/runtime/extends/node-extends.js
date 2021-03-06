var JS = Fire.JS;
var mixin = require('../mixin').mixin;
var Behavior = Fire.Behavior;

/**
 * @module Fire.Runtime
 */

/**
 * @class NodeWrapper
 */
var NodeWrapper = require('../wrappers/node');

var nodeProto = NodeWrapper.prototype;

/**
 * The parent of the wrapper.
 * If this is the top most node in hierarchy, its parent must be type SceneWrapper.
 * Changing the parent will keep the transform's local space position, rotation and scale the same but modify
 * the world space position, scale and rotation.
 * @property parent
 * @type {NodeWrapper}
 */
JS.getset(nodeProto, 'parent',
    function () {
        var parent = this.parentN;
        return parent && Fire(parent);
    },
    function (value) {
        if (FIRE_EDITOR && value) {
            if (!(value instanceof NodeWrapper)) {
                Fire.error('The new parent must be type NodeWrapper');
                return;
            }
            if (value.constructor.canHaveChildrenInEditor) {
                this.parentN = value && value.targetN;
            }
            else {
                Fire.warn('Can not add "%s" to "%s" which type is "%s".', this.name, value.name, JS.getClassName(value));
                if (!this.parentN) {
                    this.parentN = Fire.engine.getCurrentSceneN();
                }
            }
        }
        else {
            this.parentN = value && value.targetN;
        }
    }
);

/**
 * Returns a new array which contains wrappers of child nodes.
 * @property children
 * @type {NodeWrapper[]}
 */
JS.get(nodeProto, 'children',
    function () {
        if (!FIRE_EDITOR || this.constructor.canHaveChildrenInEditor) {
            return this.childrenN.map(Fire);
        }
        else {
            return [];
        }
    }
);

/**
 * The position relative to the scene.
 * @property scenePosition
 * @type {Fire.Vec2}
 * @private
 */
JS.getset(nodeProto, 'scenePosition',
    function () {
        var scene = Fire.engine && Fire.engine.getCurrentScene();
        if (!scene) {
            Fire.error('Can not access scenePosition if no running scene');
            return Fire.Vec2.zero;
        }

        return scene.transformPointToLocal( this.worldPosition );
    },
    function (value) {
        var scene = Fire.engine && Fire.engine.getCurrentScene();
        if (!scene) {
            Fire.error('Can not access scenePosition if no running scene');
            return;
        }

        this.worldPosition = scene.transformPointToWorld(value);
    }
);

/**
 * The rotation relative to the scene.
 * @property sceneRotation
 * @type {Number}
 * @private
 */
JS.getset(nodeProto, 'sceneRotation',
    function () {
        var scene = Fire.engine && Fire.engine.getCurrentScene();
        if (!scene) {
            Fire.error('Can not access sceneRotation if no running scene');
            return 0;
        }

        return this.worldRotation - scene.rotation;
    },
    function (value) {
        var scene = Fire.engine && Fire.engine.getCurrentScene();
        if (!scene) {
            Fire.error('Can not access sceneRotation if no running scene');
            return;
        }

        this.worldRotation = scene.rotation + value;
    }
);

/**
 * The lossy scale relative to the scene. (Read Only)
 * @property sceneScale
 * @type {Fire.Vec2}
 * @readOnly
 * @private
 */
JS.getset(nodeProto, 'sceneScale',
    function () {
        var scene = Fire.engine && Fire.engine.getCurrentScene();
        if (!scene) {
            Fire.error('Can not access sceneScale if no running scene');
            return Fire.Vec2.one;
        }

        return this.worldScale.div(scene.scale);
    }
);

JS.mixin(nodeProto, {
    /**
     * Is this node an instance of Scene?
     *
     * @property isScene
     */
    isScene: false,

    /**
     * Is this wrapper a child of the parentWrapper?
     *
     * @method isChildOf
     * @param {NodeWrapper} parentWrapper
     * @return {boolean} - Returns true if this wrapper is a child, deep child or identical to the given wrapper.
     */
    isChildOf: function (parentWrapper) {
        var child = this;
        do {
            if (child === parentWrapper) {
                return true;
            }
            child = child.parent;
        }
        while (child);
        return false;
    },

    /**
     * Move the node to the top.
     *
     * @method setAsFirstSibling
     */
    setAsFirstSibling: function () {
        this.setSiblingIndex(0);
    },

    /**
     * Move the node to the bottom.
     *
     * @method setAsLastSibling
     */
    setAsLastSibling: function () {
        this.setSiblingIndex(-1);
    },

    _onActivated: function () {
        if (!FIRE_EDITOR || Fire.engine._isPlaying) {
            this._onActivatedInGameMode();
        }
        else {
            this._onActivatedInEditMode();
        }
    },

    _onActivatedInGameMode: function () {
        // invoke mixin
        Behavior.onActivated(this.targetN);

        // invoke children recursively
        var children = this.childrenN;
        for (var i = 0, len = children.length; i < len; ++i) {
            var node = children[i];
            Fire(node)._onActivatedInGameMode();
        }
    },

    _onActivatedInEditMode: function () {
        if (FIRE_EDITOR) {
            // invoke wrapper
            var focused = !FIRE_TEST && Editor.Selection.curActivate('node') === this.uuid;
            if (focused) {
                if (this.onFocusInEditor) {
                    this.onFocusInEditor();
                }
            }
            else if (this.onLostFocusInEditor) {
                this.onLostFocusInEditor();
            }

            // invoke children recursively
            var children = this.childrenN;
            for (var i = 0, len = children.length; i < len; ++i) {
                var node = children[i];
                Fire(node)._onActivatedInEditMode();
            }
        }
    },

    _instantiate: function () {
        var dump = dumpNodeForInstantiation(this.targetN);
        var wrapperToNode = new Fire._RedirectWrapperToNode();
        dump = Fire._doInstantiate(dump, this, wrapperToNode);
        initNodes([dump], null, wrapperToNode);
        wrapperToNode.apply();

        var clone = dump.w;

        // init
        if (Fire.engine.isPlaying) {
            clone.name += ' (Clone)';
        }

        // invoke onLoad, note that the new node have not added to any parent yet
        clone._onActivated();

        return clone;
    }
});

function dumpNodeForSerialization (node) {
    if (FIRE_EDITOR) {
        var wrapper = Fire(node);
        wrapper.onBeforeSerialize();
        var children;
        var childrenN = wrapper.childrenN;
        if (childrenN.length > 0) {
            children = childrenN.map(dumpNodeForSerialization);
        }
        var mixinClasses = node._mixinClasses;
        var targetN = mixinClasses ? node : undefined;

        var mixin;
        if (mixinClasses) {
            if (mixinClasses.length === 1) {
                var originUuid = node._mixinContexts[0].originUuid;
                mixin = originUuid || JS._getClassId(mixinClasses[0], false);
            }
            else {
                mixin = mixinClasses.map(function (x, i) {
                    var originUuid = node._mixinContexts[i].originUuid;
                    return originUuid || JS._getClassId(x, false);
                });
            }
        }
        return {
            w: wrapper,     // wrapper properties
            t: targetN,     // target node if has mixin
            m: mixin,       // mixin class list
            c: children,    // children
        };
    }
}

function dumpNodeForInstantiation (node) {
    var wrapper = Fire(node);
    wrapper.onBeforeSerialize();

    var children, targetN, mixin;
    var childrenN = wrapper.childrenN;
    if (childrenN.length > 0) {
        children = childrenN.map(dumpNodeForInstantiation);
    }

    var mixinClasses = node._mixinClasses;
    if (mixinClasses) {
        if (mixinClasses.length === 1) {
            mixin = JS._getClassId(mixinClasses[0]);
        }
        else {
            mixin = mixinClasses.map(JS._getClassId);
        }

        targetN = {};
        for (var m = 0; m < mixinClasses.length; m++) {
            var mixinClass = mixinClasses[m];
            var props = mixinClass.__props__;
            for (var p = 0; p < props.length; p++) {
                var propName = props[p];
                var attrs = Fire.attr(mixinClass, propName);
                if (attrs.serializable === false) {
                    continue;
                }
                targetN[propName] = node[propName];
            }
        }
    }
    return {
        w: wrapper,     // wrapper properties
        t: targetN,     // target node if has mixin
        m: mixin,       // mixin class list
        c: children,    // children
    };
}

function initNodes (datas, parentNode, wrapperToNode) {
    function notFoundBeh (node, classIdToMixin) {
        if (FIRE_EDITOR) {
            mixin(node, Editor.MissingBehavior);
            var behCtx = node._mixinContexts[node._mixinContexts.length - 1];
            behCtx.originUuid = classIdToMixin;
        }
        var errorUuid = classIdToMixin;
        if (FIRE_EDITOR && Editor.isUuid(errorUuid)) {
            errorUuid = Editor.decompressUuid(errorUuid);
        }
        Fire.error('Failed to find script %s to mixin', errorUuid);
    }
    for (var i = 0, len = datas.length; i < len; i++) {
        var child = datas[i];
        var wrapper = child.w;
        wrapper.createAndAttachNode();
        if (parentNode) {
            wrapper.parentN = parentNode;
        }
        var classIdToMixin = child.m;
        var node = wrapper.targetN;
        if (classIdToMixin) {
            var classToMixin;
            var behMissed = false;
            if (Array.isArray(classIdToMixin)) {
                for (var j = 0; j < classIdToMixin.length; j++) {
                    classToMixin = JS._getClassById(classIdToMixin[j]);
                    if (classToMixin) {
                        mixin(node, classToMixin);
                        Fire.deserialize.applyMixinProps(child.t, classToMixin, node, wrapperToNode);
                    }
                    else {
                        notFoundBeh(node, classIdToMixin[j]);
                        behMissed = true;
                    }
                }
            }
            else {
                classToMixin = JS._getClassById(classIdToMixin);
                if (classToMixin) {
                    mixin(node, classToMixin);
                    Fire.deserialize.applyMixinProps(child.t, classToMixin, node, wrapperToNode);
                }
                else {
                    notFoundBeh(node, classIdToMixin);
                    behMissed = true;
                }
            }
            if (behMissed && FIRE_EDITOR) {
                node._mixin.originNodeData = child.t;
            }
        }
        var children = child.c;
        if (children) {
            initNodes(children, node, wrapperToNode);
        }
    }
}

module.exports = {
    dumpNodeForSerialization: dumpNodeForSerialization,
    initNodes: initNodes
};
