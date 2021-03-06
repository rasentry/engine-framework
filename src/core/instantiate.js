﻿var FObject = Fire.FObject;
var Def = require('../core/definition');
var PersistentMask = Def.PersistentMask;
//var NodeSavedAsWrapper = Def.NodeSavedAsWrapper;
var _isDomNode = require('../core/utils').isDomNode;

/**
 * !#en Clones the object original and returns the clone.
 *
 * See [Clone exists Entity](/en/scripting/create-destroy-entities/#instantiate)
 *
 * !#zh 复制给定的对象
 *
 * 详细用法可参考[复制已有Entity](/zh/scripting/create-destroy-entities/#instantiate)
 *
 * Instantiate 时，function 和 dom 等非可序列化对象会直接保留原有引用，Asset 会直接进行浅拷贝，可序列化类型会进行深拷贝。
 * <del>对于 Entity / Component 等 Scene Object，如果对方也会被一起 Instantiate，则重定向到新的引用，否则保留为原来的引用。</del>
 *
 * @method instantiate
 * @param {object} original - An existing object that you want to make a copy of.
 * @return {object} the newly instantiated object
 */
function instantiate (original) {
    if (typeof original !== 'object' || Array.isArray(original)) {
        Fire.error('The thing you want to instantiate must be an object');
        return null;
    }
    if (!original) {
        Fire.error('The thing you want to instantiate is nil');
        return null;
    }
    if (original instanceof FObject && !original.isValid) {
        Fire.error('The thing you want to instantiate is destroyed');
        return null;
    }

    var isRuntimeNode = Fire.getWrapperType(original);
    if (isRuntimeNode) {
        var wrapper = Fire.instantiate(Fire(original));
        return wrapper.targetN;
    }

    var clone;
    if (original instanceof FObject) {
        // invoke _instantiate method if supplied
        if (original._instantiate) {
            Fire.engine._isCloning = true;
            clone = original._instantiate();
            Fire.engine._isCloning = false;
            return clone;
        }
        else if (original instanceof Fire.Asset) {
            // 不允许用通用方案实例化资源
            Fire.error('The instantiate method for given asset do not implemented');
            return null;
        }
    }

    Fire.engine._isCloning = true;
    clone = doInstantiate(original);
    Fire.engine._isCloning = false;
    return clone;
}

/*
 * Reserved tags:
 * - _iN$t: the cloned instance
 */

var objsToClearTmpVar = [];   // 用于重设临时变量

///**
// * Do instantiate object, the object to instantiate must be non-nil.
// * 这是一个通用的 instantiate 方法，可能效率比较低。
// * 之后可以给各种类型重载快速实例化的特殊实现，但应该在单元测试中将结果和这个方法的结果进行对比。
// * 值得注意的是，这个方法不可重入，不支持 mixin。
// *
// * @param {object} obj - 该方法仅供内部使用，用户需负责保证参数合法。什么参数是合法的请参考 Fire.instantiate 的实现。
// * @param {NodeWrapper} [parent] - 只有在该对象下的场景物体会被克隆。
// * @param {_RedirectWrapperToNode} [wrapperToNode]
// * @return {object}
// * @private
// */
function doInstantiate (obj, parent, wrapperToNode) {
    if (Array.isArray(obj)) {
        Fire.error('Can not instantiate array');
        return null;
    }
    if (_isDomNode && _isDomNode(obj)) {
        Fire.error('Can not instantiate DOM element');
        return null;
    }

    var clone = enumerateObject(obj, parent, wrapperToNode);

    for (var i = 0, len = objsToClearTmpVar.length; i < len; ++i) {
        objsToClearTmpVar[i]._iN$t = null;
    }
    objsToClearTmpVar.length = 0;

    return clone;
}

///**
// * @param {object} obj - The object to instantiate, typeof must be 'object' and should not be an array.
// * @return {object} - the instantiated instance
// */
var enumerateObject = function (obj, parent, wrapperToNode) {
    var value, type, key;
    var klass = obj.constructor;
    var clone = new klass();
    obj._iN$t = clone;
    objsToClearTmpVar.push(obj);
    if (Fire._isFireClass(klass)) {
        var props = klass.__props__;
        for (var p = 0; p < props.length; p++) {
            key = props[p];
            var attrs = Fire.attr(klass, key);
            if (attrs.serializable !== false) {
                value = obj[key];
                type = typeof value;
                if (type === 'object') {
                    clone[key] = value ? instantiateObj(value, parent, wrapperToNode, clone, key) : value;
                }
                else {
                    clone[key] = (type !== 'function') ? value : null;
                }
            }
        }
        if (clone instanceof Fire.Runtime.NodeWrapper) {
            clone._id = '';
        }
    }
    else {
        // primitive javascript object
        for (key in obj) {
            //Fire.log(key);
            if (!obj.hasOwnProperty(key) || (key.charCodeAt(0) === 95 && key.charCodeAt(1) === 95)) {  // starts with __
                continue;
            }
            value = obj[key];
            if (value === clone) {
                continue;   // value is obj._iN$t
            }
            // instantiate field
            type = typeof value;
            if (type === 'object') {
                clone[key] = value ? instantiateObj(value, parent, wrapperToNode, clone, key) : value;
            }
            else {
                clone[key] = (type !== 'function') ? value : null;
            }
        }
    }
    if (obj instanceof FObject) {
        clone._objFlags &= PersistentMask;
    }
    return clone;
};

///**
// * @return {object} - the original non-nil object, typeof must be 'object'
// */
function instantiateObj (obj, parent, wrapperToNode, ownerObj, ownerKey) {
    // 目前使用“_iN$t”这个特殊字段来存实例化后的对象，这样做主要是为了防止循环引用
    // 注意，为了避免循环引用，所有新创建的实例，必须在赋值前被设为源对象的_iN$t
    var clone = obj._iN$t;
    if (clone) {
        // has been instantiated
        return clone;
    }

    if (obj instanceof Fire.Asset) {
        // 所有资源直接引用，不需要拷贝
        return obj;
    }
    else if (Array.isArray(obj)) {
        var len = obj.length;
        clone = new Array(len);
        obj._iN$t = clone;
        for (var i = 0; i < len; ++i) {
            var value = obj[i];
            // instantiate field
            var type = typeof value;
            if (type === 'object') {
                clone[i] = value ? instantiateObj(value, parent, wrapperToNode, clone, '' + i) : value;
            }
            else {
                clone[i] = (type !== 'function') ? value : null;
            }
        }
        objsToClearTmpVar.push(obj);
        return clone;
    }
    //else if (_isDomNode && _isDomNode(obj)) {
    //    return obj;
    //}
    else {
        var isRuntimeNode = Fire.getWrapperType(obj);
        if (isRuntimeNode) {
            var wrapper = Fire(obj);
            clone = wrapper._iN$t;
            if (clone) {
                if (wrapperToNode) {
                    wrapperToNode.register(ownerObj, ownerKey);
                }
                return clone;
            }
            if (parent && !wrapper.isChildOf(parent)) {
                return obj;
            }
            if (wrapperToNode) {
                wrapperToNode.register(ownerObj, ownerKey);
            }
            return enumerateObject(wrapper, parent, wrapperToNode);
            //clone._objFlags |= NodeSavedAsWrapper;
            //return clone;
        }
        else {
            var ctor = obj.constructor;
            if (Fire._isFireClass(ctor)) {
                if (parent && obj instanceof Fire.Runtime.NodeWrapper) {
                    if (!obj.isChildOf(parent)) {
                        // 不拷贝其它场景对象，保持原有引用
                        return obj;
                    }
                }
            }
            else if (ctor !== Object) {
                // unknown type
                return obj;
            }
        }
        return enumerateObject(obj, parent, wrapperToNode);
    }
}

Fire.instantiate = instantiate;
Fire._doInstantiate = doInstantiate;
module.exports = instantiate;
