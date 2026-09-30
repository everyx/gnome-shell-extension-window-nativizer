/**
 * Pure base class providing modern GNOME 51 ShaderEffect interface.
 *
 * In GNOME 51+, Shell.GLSLEffect was removed in favor of Clutter.ShaderEffect.
 * This module transparently adapts Clutter.ShaderEffect (GNOME 51+) and
 * Shell.GLSLEffect (GNOME 45–50) with zero global prototype mutation.
 *
 * Subclasses provide shader code via `static getShaderSource()` returning
 * `{hook?, declarations, code, replace?}`, and upload uniforms via
 * `this.set_uniform_float(name, n_components, value)`. That source must be a constant:
 * Clutter asks the modern branch for a *static* snippet, so it is built once and
 * cached on the class - a source that varied per instance would be answered with
 * whichever instance asked first.
 *
 * The modern branch deliberately defines no `set_uniform_float`: Mutter 51 added the
 * introspectable `clutter_shader_effect_set_uniform_float(name, n_components, value)`
 * (its `(array length=total_count)` argument is hidden by GJS) exactly to replace
 * Shell.GLSLEffect's. Defining one here would shadow that native method, and a partial
 * reimplementation (e.g. via `set_uniform_value`) would drop vector components.
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
         * Sets float uniform using variable name, caching location on GNOME 45–50.
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
