package dev.keyframer.inspector.core

// The types keyframer-inspector's API names, so code written against it compiles unchanged. Nothing
// here is ever created: Keyframer.signal returns null in the no-op.

/** A value the panel records and plays back. See keyframer-inspector-core. */
interface Signal {
    val site: SignalSite
    fun read(): Double?
    fun write(v: Double) {}
    fun hold() {}
    fun release() {}
}

/** Where a value is written. See keyframer-inspector-core. */
data class SignalSite(
    val id: String,
    val file: String,
    val line: Int,
    val component: String?,
    val name: String?,
    val column: Int? = 0,
    val writable: Boolean? = null,
    val kind: String? = null,
    val prop: String? = null,
)

/** An interaction an editor or an agent can run. See keyframer-inspector-core. */
fun interface Scenario {
    fun run(done: (Throwable?) -> Unit)
}
