/**
 * Adapts between Clutter.ShaderEffect (GNOME 51+) and Shell.GLSLEffect (GNOME 50).
 * Subclasses provide static shader source via getShaderSource().
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';

import {resolveUniformLocation} from './uniformLocation.js';

// Shell.GLSLEffect was dropped in GNOME 51 (gi://Shell namespace import remains valid,
// but Shell.GLSLEffect evaluates to undefined). When undefined, we take the modern
// Clutter.ShaderEffect branch.
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

        /**
         * Sets float uniform using variable name, caching location on GNOME 50.
         * Targets modern GNOME 51 3-argument signature: (name, n_components, value).
         * @param {string} name
         * @param {number} n_components
         * @param {number|number[]} value
         */
        set_uniform_float(name, n_components, value) {
            // The map is created in _init; build_pipeline() may run before that, so treat
            // it as optional here too rather than assuming its presence.
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
