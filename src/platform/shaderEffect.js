/** Adapts Clutter.ShaderEffect (51+) and Shell.GLSLEffect (50); subclasses supply the source. */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';

import {resolveUniformLocation} from './uniformLocation.js';

/** Shell.GLSLEffect is gone in GNOME 51, so the undefined class is what picks the modern branch. */
export const ShaderEffect = Shell?.GLSLEffect
    ? GObject.registerClass({
        GTypeName: 'WindowNativizerShaderEffectCompat',
    }, class ShaderEffectLegacy extends Shell.GLSLEffect {
        _init(params) {
            super._init(params);
            this._uniformLocMap = new Map();
        }

        vfunc_build_pipeline() {
            this._uniformLocMap?.clear();
            const source = this.constructor.getShaderSource?.();
            if (source) {
                this.add_glsl_snippet(
                    source.hook ?? Cogl.SnippetHook.FRAGMENT,
                    source.declarations ?? '',
                    source.code ?? '',
                    Boolean(source.replace)
                );
            }
        }

        /** The 50 API takes a uniform location, so the name is resolved through a cache. */
        set_uniform_float(name, n_components, value) {
            // The map is created in _init, which build_pipeline() can run before; keep it optional.
            const cache = this._uniformLocMap ??= new Map();
            const loc = resolveUniformLocation(cache, name, n => this.get_uniform_location(n));
            if (loc !== -1)
                super.set_uniform_float(loc, n_components, value);
        }
    })
    : GObject.registerClass({
        GTypeName: 'WindowNativizerShaderEffectCompat',
    }, class ShaderEffectModern extends Clutter.ShaderEffect {
        vfunc_get_static_snippet() {
            if (this.constructor._staticSnippet)
                return this.constructor._staticSnippet;

            const source = this.constructor.getShaderSource?.();
            if (source) {
                const hook = source.hook ?? Cogl.SnippetHook.FRAGMENT;
                const declarations = source.declarations ?? '';
                const post = source.replace ? null : source.code ?? '';
                const s = Cogl.Snippet.new
                    ? Cogl.Snippet.new(hook, declarations, post)
                    : new Cogl.Snippet(hook, declarations, post);
                if (source.replace)
                    s.set_replace(source.code ?? '');
                return (this.constructor._staticSnippet = s);
            }
            return null;
        }
    });
