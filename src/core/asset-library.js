﻿var JS = require('./js');
var Asset = Fire.Asset;
var callInNextTick = require('./utils').callInNextTick;
var LoadManager = require('./load-manager');


/**
 * The asset library which managing loading/unloading assets in project.
 *
 * @class AssetLibrary
 * @static
 */

// configs

var _libraryBase = '';
var _uuidToRawAssets = {};

// variables

// the loading uuid's callbacks
var _uuidToCallbacks = new Fire.CallbacksInvoker();

// temp deserialize info
var _tdInfo = new Fire._DeserializeInfo();

// create a loading context which reserves all relevant parameters
function LoadingHandle (readMainCache, writeMainCache, recordAssets, reassociateNode) {
    //this.readMainCache = readMainCache;
    //this.writeMainCache = writeMainCache;

    // FORCE ignore global cache in fireball lite
    this.readMainCache = false;
    this.writeMainCache = false;

    var needIndieCache = !(this.readMainCache && this.writeMainCache);
    this.taskIndieCache = needIndieCache ? {} : null;

    // 需要让场景 preload 的 asset（所有包含 raw file 后缀名的 asset 并且不含 rawType 属性的 asset）
    this.assetsNeedPostLoad = recordAssets ? [] : null;
    // 需要让场景 preload 的 url
    this.urlsNeedPreload = {};

    this.wrapperToNode = reassociateNode ? new Fire._RedirectWrapperToNode() : null;
}
LoadingHandle.prototype.readCache = function (uuid) {
    if (this.readMainCache && this.writeMainCache) {
        return AssetLibrary._uuidToAsset[uuid];
    }
    else {
        if (this.readMainCache) {
            // writeMainCache == false
            return AssetLibrary._uuidToAsset[uuid] || this.taskIndieCache[uuid];
        }
        else {
            return this.taskIndieCache[uuid];
        }
    }
};
LoadingHandle.prototype.writeCache = function (uuid, asset, hasRawType) {
    if (this.writeMainCache) {
        AssetLibrary._uuidToAsset[uuid] = asset;
    }
    if (this.taskIndieCache) {
        this.taskIndieCache[uuid] = asset;
    }
    if (this.assetsNeedPostLoad && asset._rawFiles && !hasRawType) {
        this.assetsNeedPostLoad.push(asset);
    }
};

// publics

var AssetLibrary = {
    /**
     * @callback loadCallback
     * @param {string} error - null or the error info
     * @param {Asset} data - the loaded asset or null
     */

    /**
     * @method loadAsset
     * @param {string} uuid
     * @param {loadCallback} callback - the callback function once load finished
     * @param {Boolean} [readMainCache=true] - If false, the asset and all its depends assets will reload and create new instances from library.
     * @param {Boolean} [writeMainCache=true] - If true, the result will cache to AssetLibrary, and MUST be unload by user manually.
     * @param {Asset} [existingAsset] - load to existing asset, this argument is only available in editor
     * @private
     */
    loadAsset: function (uuid, callback, readMainCache, writeMainCache, existingAsset) {
        readMainCache = typeof readMainCache !== 'undefined' ? readMainCache : true;
        writeMainCache = typeof writeMainCache !== 'undefined' ? writeMainCache : true;

        var handle = new LoadingHandle(readMainCache, writeMainCache);
        this._loadAssetByUuid(uuid, callback, handle, existingAsset);
    },

    _LoadingHandle: LoadingHandle,

    getImportedDir: function (uuid) {
        return _libraryBase + uuid.slice(0, 2)/* + Fire.Path.sep + uuid*/;
    },

    _queryAssetInfoInEditor: function (uuid, callback) {
        if (FIRE_EDITOR) {
            Editor.sendRequestToCore( 'scene:query-asset-info-by-uuid', uuid, function (info) {
                if (info) {
                    var ctor = Editor.assets[info.type];
                    if (ctor) {
                        var isRawAsset = !Fire.isChildClassOf(ctor, Asset);
                        callback(null, info.url, isRawAsset, ctor);
                    }
                    else {
                        callback(new Error('Can not find asset type ' + info.type));
                    }
                }
                else {
                    callback(new Error('Can not get asset url by uuid ' + uuid));
                }
            });
        }
    },

    _getAssetInfoInRuntime: function (uuid) {
        var info = _uuidToRawAssets[uuid];
        if (info) {
            return {
                url: Fire.url._rawAssets + info.url,
                raw: info.raw,
            };
        }
        else {
            var url = this.getImportedDir(uuid) + Fire.Path.sep + uuid + '.json';
            return {
                url: url,
                raw: false,
            };
        }
    },

    /**
     * @method queryAssetInfo
     * @param {string} uuid
     * @param {function} callback
     * @param {Error} callback.error
     * @param {string} callback.url - the url of raw asset or imported asset
     * @param {boolean} callback.raw - indicates whether the asset is raw asset
     * @param {function} callback.ctorInEditor - the actual type of asset, used in editor only
     */
    queryAssetInfo: function (uuid, callback) {
        if (FIRE_EDITOR && !FIRE_TEST) {
            this._queryAssetInfoInEditor(uuid, callback);
        }
        else {
            var info = this._getAssetInfoInRuntime(uuid);
            callback(null, info.url, info.raw);
        }
    },

    // parse uuid out of url
    parseUuidInEditor: function (url) {
        if (FIRE_EDITOR) {
            var uuid = "";
            var isImported = url.startsWith(_libraryBase);
            if (isImported) {
                var dir = Fire.Path.dirname(url);
                var dirBasename = Fire.Path.basename(dir);

                var isAssetUrl = dirBasename.length === 2;
                if (isAssetUrl) {
                    uuid = Fire.Path.basename(url);
                    var index = uuid.indexOf('.');
                    if (index !== -1) {
                        uuid = uuid.slice(0, index);
                    }
                }
                else {
                    // raw file url
                    uuid = dirBasename;
                }
            }
            // If url is not in the library, just return ""
            return uuid;
        }
    },

    /**
     * !#zh uuid加载流程：
     * 1. 查找_uuidToAsset，如果已经加载过，直接返回
     * 2. 查找_uuidToCallbacks，如果已经在加载，则注册回调，直接返回
     * 3. 如果没有url，则将uuid直接作为路径
     * 4. 递归加载Asset及其引用到的其它Asset
     *
     * @method _loadAssetByUuid
     * @param {string} uuid
     * @param {loadCallback} callback - the callback to receive the asset, can be null
     * @param {LoadingHandle} handle - the loading context which reserves all relevant parameters
     * @param {Asset} [existingAsset] - load to existing asset, this argument is only available in editor
     * @private
     */
    _loadAssetByUuid: function (uuid, callback, handle, existingAsset) {
        if (typeof uuid !== 'string') {
            callInNextTick(callback, new Error('[AssetLibrary] uuid must be string'), null);
            return;
        }
        // step 1
        if ( !existingAsset ) {
            var asset = handle.readCache(uuid);
            if (asset) {
                callInNextTick(callback, null, asset);
                return;
            }
        }

        // step 2
        // 如果必须重新加载，则不能合并到到 _uuidToCallbacks，否则现有的加载成功后会同时触发回调，
        // 导致提前返回的之前的资源。
        var canShareLoadingTask = handle.readMainCache && !existingAsset;
        if ( canShareLoadingTask && !_uuidToCallbacks.add(uuid, callback) ) {
            // already loading
            return;
        }

        // step 3 4

        //if (FIRE_EDITOR && !_libraryBase) {
        //    callInNextTick(callback, new Error('Cannot load ' + uuid + ' in editor because AssetLibrary not yet initialized!'), null);
        //    return;
        //}
        function onload (error, json, url) {
            function onDeserializedWithDepends (err, asset, hasRawType) {
                if (asset) {
                    asset._uuid = uuid;
                    handle.writeCache(uuid, asset, hasRawType);
                }
                if ( canShareLoadingTask ) {
                    _uuidToCallbacks.invokeAndRemove(uuid, err, asset);
                }
                else if (callback) {
                    callback(err, asset);
                }
            }
            if (json) {
                AssetLibrary._deserializeWithDepends(json, url, onDeserializedWithDepends, handle, existingAsset);
            }
            else {
                onDeserializedWithDepends(error, null);
            }
        }

        if (FIRE_EDITOR && !FIRE_TEST) {
            this._queryAssetInfoInEditor(uuid, function (err, url, isRawAsset) {
                if (err) {
                    callback(err);
                }
                else {
                    var shouldLoadByEngine = !isRawAsset;
                    if (!shouldLoadByEngine) {
                        return callback(new Error('Should not load raw file in AssetLibrary, uuid: ' + uuid));
                    }
                    LoadManager.loadByLoader(Fire._JsonLoader, url, function (error, json) {
                        onload(error, json, url);
                    });
                }
            });
        }
        else {
            var info = this._getAssetInfoInRuntime(uuid);
            if (info.raw) {
                return callback(new Error('Should not load raw file in AssetLibrary, uuid: ' + uuid));
            }
            LoadManager.loadByLoader(Fire._JsonLoader, info.url, function (error, json) {
                onload(error, json, info.url);
            });
        }
    },

    /**
     * @method loadJson
     * @param {string|object} json
     * @param {loadCallback} callback
     * @param {boolean} [dontCache=false] - If false, the result will cache to AssetLibrary, and MUST be unload by user manually.
     * @param {boolean} [recordAssets=false] - 是否统计新加载的需要让场景 preload 的 asset（所有包含 raw file 后缀名的 asset 并且不含 rawType 属性的 asset）
     * * @param {boolean} [reassociateNode=false] - 是否统计需要重新关联的节点数据
     * @return {LoadingHandle}
     * @private
     */
    loadJson: function (json, callback, dontCache, recordAssets, reassociateNode) {
        var handle = new LoadingHandle(!dontCache, !dontCache, recordAssets, reassociateNode);
        var thisTick = true;
        this._deserializeWithDepends(json, '', function (p1, p2) {
            if (thisTick) {
                callInNextTick(callback, p1, p2);
            }
            else {
                callback(p1, p2);
            }
        }, handle);
        thisTick = false;
        return handle;
    },

    /**
     * @method _deserializeWithDepends
     * @param {string|object} json
     * @param {string} url
     * @param {loadCallback} callback
     * @param {object} handle - the loading context which reserves all relevant parameters
     * @param {Asset} [existingAsset] - existing asset to reload
     * @private
     */
    _deserializeWithDepends: function (json, url, callback, handle, existingAsset) {
        // deserialize asset
        //var isScene = typeof Scene !== 'undefined' && json && json[0] && json[0].__type__ === JS._getClassId(Scene);
        //var classFinder = isScene ? Fire._MissingScript.safeFindClass : function (id) {
        var classFinder = function (id) {
            var cls = JS._getClassById(id);
            if (cls) {
                return cls;
            }
            Fire.warn('Can not get class "%s"', id);
            return Object;
        };

        var asset = Fire.deserialize(json, _tdInfo, {
            classFinder: classFinder,
            target: existingAsset
        });

        if (handle.wrapperToNode && _tdInfo.wrapperToNode) {
            handle.wrapperToNode.concat(_tdInfo.wrapperToNode);
        }

        // load depends
        var pendingCount = _tdInfo.uuidList.length;

        // load raw
        var rawProp = _tdInfo.rawProp;     // _tdInfo不能用在回调里！
        if (rawProp) {
            // load depends raw objects
            var attrs = Fire.attr(asset.constructor, _tdInfo.rawProp);
            var rawType = attrs.rawType;
            ++pendingCount;
            LoadManager.load(url, rawType, asset._rawext, function onRawObjLoaded (error, raw) {
                if (error) {
                    Fire.error('[AssetLibrary] Failed to load %s of %s. %s', rawType, url, error);
                }
                asset[rawProp] = raw;
                --pendingCount;
                if (pendingCount === 0) {
                    callback(null, asset, true);
                }
            });
        }

        if (pendingCount === 0) {
            callback(null, asset, !!rawProp);
            // _tdInfo 是用来重用的临时对象，每次使用后都要重设，这样才对 GC 友好。
            _tdInfo.reset();
            return;
        }

        /*
         如果依赖的所有资源都要重新下载，批量操作时将会导致同时执行多次重复下载。优化方法是增加一全局事件队列，
         队列保存每个任务的注册，启动，结束事件，任务从注册到启动要延迟几帧，每个任务都存有父任务。
         这样通过队列的事件序列就能做到合并批量任务。
         如果依赖的资源不重新下载也行，但要判断是否刚好在下载过程中，如果是的话必须等待下载完成才能结束本资源的加载，
         否则外部获取到的依赖资源就会是旧的。
         */

        // load depends assets
        for (var i = 0, len = _tdInfo.uuidList.length; i < len; i++) {
            var dependsUuid = _tdInfo.uuidList[i];
            (function (dependsUuid, obj, prop) {
                AssetLibrary.queryAssetInfo(dependsUuid, function (err, dependsUrl, isRawAsset) {
                    if (err) {
                        Fire.error('[AssetLibrary] Failed to load "%s", %s', dependsUuid, err);
                    }
                    else if (isRawAsset) {
                        // update url
                        obj[prop] = dependsUrl;
                        handle.urlsNeedPreload[dependsUrl] = true;
                    }
                    if (err || isRawAsset) {
                        --pendingCount;
                        if (callback && pendingCount === 0) {
                            callback(null, asset, !!rawProp);
                            callback = null;
                        }
                        return;
                    }

                    var onDependsAssetLoaded = function (error, dependsAsset, hasRawType) {
                        if (FIRE_EDITOR && error) {
                            if (Editor.AssetDB && Editor.AssetDB.isValidUuid(dependsUuid)) {
                                Fire.error('[AssetLibrary] Failed to load "%s", %s', dependsUuid, error);
                            }
                        }
                        //else {
                        //    dependsAsset._uuid = dependsUuid;
                        //}
                        // update reference
                        obj[prop] = dependsAsset;
                        //
                        --pendingCount;
                        if (callback && pendingCount === 0) {
                            callback(null, asset, !!rawProp);
                            callback = null;
                        }
                    };
                    AssetLibrary._loadAssetByUuid(dependsUuid, onDependsAssetLoaded, handle);
                });
            })( dependsUuid, _tdInfo.uuidObjList[i], _tdInfo.uuidPropList[i] );
        }

        // AssetLibrary._loadAssetByUuid 的回调有可能在当帧也可能延后执行，所以这里要判断 callback 来防止多次调用
        if (callback && pendingCount === 0) {
            callback(null, asset, !!rawProp);
            callback = null;
        }

        // _tdInfo 是用来重用的临时对象，每次使用后都要重设，这样才对 GC 友好。
        _tdInfo.reset();
    },

    /**
     * Get the exists asset by uuid.
     *
     * @method getAssetByUuid
     * @param {string} uuid
     * @return {Asset} - the existing asset, if not loaded, just returns null.
     * @private
     */
    getAssetByUuid: function (uuid) {
        return AssetLibrary._uuidToAsset[uuid] || null;
    },

    /**
     * !#en Kill references to the asset so it can be garbage collected.
     * Fireball will reload the asset from disk or remote if loadAssetByUuid being called again.
     * You rarely use this function in scripts, since it will be called automatically when the Asset is destroyed.
     * !#zh 手动卸载指定的资源，这个方法会在 Asset 被 destroy 时自动调用，一般不需要用到这个方法。卸载以后，Fireball 可以重新从硬盘或网络加载这个资源。
     *
     * 如果还有地方引用到asset，除非 destroyImmediated 为true，否则不应该执行这个方法，因为那样可能会导致 asset 被多次创建。
     *
     * @method unloadAsset
     * @param {Asset|string} assetOrUuid
     * @param {Boolean} [destroy=false] - When destroyImmediate is true, if there are objects referencing the asset, the references will become invalid.
     */
    unloadAsset: function (assetOrUuid, destroy) {
        var asset;
        if (typeof assetOrUuid === 'string') {
            asset = AssetLibrary._uuidToAsset[assetOrUuid];
        }
        else {
            asset = assetOrUuid;
        }
        if (asset) {
            if (destroy && asset.isValid) {
                asset.destroy();
            }
            delete AssetLibrary._uuidToAsset[asset._uuid];
        }
    },

    /**
     * init the asset library
     *
     * @method init
     * @param {string} libraryPath - 能接收的任意类型的路径，通常在编辑器里使用绝对的，在网页里使用相对的。
     * @param {string} rawAssetsBase - base of raw asset's urls (only used in runtime)
     * @param {object} rawAssets - uuid to raw asset's urls (only used in runtime)
     */
    init: function (libraryPath, rawAssetsBase, rawAssets) {
        if (FIRE_EDITOR && _libraryBase && !FIRE_TEST) {
            Fire.error('AssetLibrary has already been initialized!');
            return;
        }

        // 这里将路径转 url，不使用路径的原因是有的 runtime 不能解析 "\" 符号。
        // 不使用 url.format 的原因是 windows 不支持 file:// 和 /// 开头的协议，所以只能用 replace 操作直接把路径转成 URL。
        libraryPath = libraryPath.replace(/\\/g, '/');

        _libraryBase = Fire.Path.setEndWithSep(libraryPath, '/');
        Fire.url._rawAssets = Fire.Path.setEndWithSep(rawAssetsBase || '', '/');
        _uuidToRawAssets = rawAssets || {};
    }
};

// unload asset if it is destoryed

/**
 * !#en Caches uuid to all loaded assets in scenes.
 *
 * !#zh 这里保存所有已经加载的场景资源，防止同一个资源在内存中加载出多份拷贝。
 *
 * 这里用不了WeakMap，在浏览器中所有加载过的资源都只能手工调用 unloadAsset 释放。
 *
 * 参考：
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakMap
 * https://github.com/TooTallNate/node-weak
 *
 * @property _uuidToAsset
 * @type {object}
 * @private
 */
AssetLibrary._uuidToAsset = {};

//暂时屏蔽，因为目前没有缓存任何asset
//if (FIRE_DEV && Asset.prototype._onPreDestroy) {
//    Fire.error('_onPreDestroy of Asset has already defined');
//}
//Asset.prototype._onPreDestroy = function () {
//    if (AssetLibrary._uuidToAsset[this._uuid] === this) {
//        AssetLibrary.unloadAsset(this);
//    }
//};

Fire.AssetLibrary = AssetLibrary;
